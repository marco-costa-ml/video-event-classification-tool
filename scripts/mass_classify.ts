import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { classificationConfigSchema, type ClassificationConfig } from "../src/schemas/index.ts";
import type { PredicateNode, ValueExpr } from "../src/schemas/predicates.ts";
import type { TimelineEvent } from "../src/schemas/labels.ts";
import { loadParquetObjects, loadParquetOcr } from "../src/services/parquetIngest.ts";
import { createFrameStateCache } from "../src/domain/frameReconstruction.ts";
import { evaluateEventsAtFrame } from "../src/domain/eventEngine.ts";
import { collapsePredictedEvents } from "../src/domain/eventDedupe.ts";
import { buildEnrichedExport, type EnrichedExport } from "../src/services/exportService.ts";

type CliOptions = {
  configPath: string;
  derivedRoot: string;
  outputRoot: string;
  ocrSubdir: string;
  objectsSubdir: string;
  ocrFilename: string;
  objectsFilename: string;
  chunkFrames: number;
  workers: number;
  manifestName: string;
  shardIndex: number | null;
  shardCount: number | null;
  onlyVideoIds: Set<string> | null;
};

type RunSummary = {
  video_id: string;
  output_path: string;
  detected_events: number;
  enriched_records: number;
  elapsed_ms: number;
};

type RunFailure = {
  video_id: string;
  error: string;
};

type ManifestDoc = {
  generated_at: string;
  config_path: string;
  derived_root: string;
  chunk_frames: number;
  workers: number;
  shard_index: number | null;
  shard_count: number | null;
  results: RunSummary[];
  failures: RunFailure[];
};

const DEFAULTS: Omit<CliOptions, "onlyVideoIds"> = {
  configPath: "data/classification.json",
  derivedRoot: "data/derived",
  outputRoot: "data/derived/enriched_events",
  ocrSubdir: "ocr_corrected",
  objectsSubdir: "composed_state",
  ocrFilename: "rec_corrected.parquet",
  objectsFilename: "composed_state.parquet",
  chunkFrames: 18_000,
  workers: 1,
  manifestName: "_manifest.json",
  shardIndex: null,
  shardCount: null,
};

const FRAME_SCAN_CHUNK_ROWS = 250_000;
const CHILD_MAX_OLD_SPACE_MB = 6144;

function parseArgs(argv: string[]): CliOptions {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    out[key] = value;
    i += 1;
  }
  const onlyVideoIds = out.video_ids
    ? new Set(
        out.video_ids
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;
  return {
    configPath: out.config ?? DEFAULTS.configPath,
    derivedRoot: out.derived_root ?? DEFAULTS.derivedRoot,
    outputRoot: out.output_root ?? DEFAULTS.outputRoot,
    ocrSubdir: out.ocr_subdir ?? DEFAULTS.ocrSubdir,
    objectsSubdir: out.objects_subdir ?? DEFAULTS.objectsSubdir,
    ocrFilename: out.ocr_file ?? DEFAULTS.ocrFilename,
    objectsFilename: out.objects_file ?? DEFAULTS.objectsFilename,
    chunkFrames: Number(out.chunk_frames ?? DEFAULTS.chunkFrames),
    workers: Number(out.workers ?? DEFAULTS.workers),
    manifestName: out.manifest_name ?? DEFAULTS.manifestName,
    shardIndex: out.shard_index === undefined ? null : Number(out.shard_index),
    shardCount: out.shard_count === undefined ? null : Number(out.shard_count),
    onlyVideoIds,
  };
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function intAtLeast(name: string, value: number, min: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return value;
}

function normalizeManifestName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new Error("manifest_name must be a simple filename");
  }
  return trimmed;
}

function validateShardArgs(opts: CliOptions): void {
  if (opts.shardIndex === null && opts.shardCount === null) return;
  if (opts.shardIndex === null || opts.shardCount === null) {
    throw new Error("Both --shard_index and --shard_count are required together.");
  }
  opts.shardCount = intAtLeast("shard_count", opts.shardCount, 1);
  opts.shardIndex = intAtLeast("shard_index", opts.shardIndex, 0);
  if (opts.shardIndex >= opts.shardCount) {
    throw new Error("shard_index must be less than shard_count.");
  }
}

function frameShift(config: ClassificationConfig, maxRawFrame: number): number {
  const startSec = config.video.video_start_time_seconds ?? 0;
  const fps = config.video.fps;
  if (startSec <= 0 || fps <= 0) return 0;
  const browserWindowMax = Math.max(1, Math.floor(20 * 60 * fps)) - 1;
  if (maxRawFrame <= browserWindowMax) return 0;
  return Math.round(startSec * fps);
}

function depsFromValueExpr(expr: ValueExpr): { past: number; future: number } {
  if (expr.kind !== "window_field") return { past: 0, future: 0 };
  if (expr.offset_frames < 0) return { past: Math.abs(expr.offset_frames), future: 0 };
  return { past: 0, future: expr.offset_frames };
}

function mergeDeps(a: { past: number; future: number }, b: { past: number; future: number }) {
  return { past: Math.max(a.past, b.past), future: Math.max(a.future, b.future) };
}

function predicateDeps(node: PredicateNode): { past: number; future: number } {
  switch (node.kind) {
    case "logical":
      return node.children.reduce((acc, child) => mergeDeps(acc, predicateDeps(child)), { past: 0, future: 0 });
    case "comparison":
      return mergeDeps(depsFromValueExpr(node.left), depsFromValueExpr(node.right));
    case "change":
    case "transition":
      return { past: node.window_frames, future: 0 };
    case "aggregate":
      return node.filter ? predicateDeps(node.filter) : { past: 0, future: 0 };
    case "temporal": {
      const c = predicateDeps(node.child);
      const low = node.offset_frames - node.window_before - c.past;
      const high = node.offset_frames + node.window_after + c.future;
      return {
        past: Math.max(0, -low),
        future: Math.max(0, high),
      };
    }
    default:
      return { past: 0, future: 0 };
  }
}

function computeOverlaps(config: ClassificationConfig): { past: number; future: number } {
  let deps = { past: 0, future: 0 };
  for (const p of config.pages) deps = mergeDeps(deps, predicateDeps(p.match));
  for (const ev of config.events) {
    deps = mergeDeps(deps, predicateDeps(ev.predicate));
    deps.past = Math.max(deps.past, ev.cooldown_frames ?? 0);
  }
  return { past: deps.past + 2, future: deps.future + 2 };
}

async function readDirSafe(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries.filter((d) => d.isDirectory()).map((d) => d.name);
}

function normalizeVideoIds(names: string[]): string[] {
  return names
    .map((name) => /^video_id=(.+)$/.exec(name)?.[1] ?? null)
    .filter((x): x is string => x !== null);
}

async function discoverVideoIds(ocrRoot: string, objRoot: string, only: Set<string> | null): Promise<string[]> {
  const [ocrDirs, objDirs] = await Promise.all([readDirSafe(ocrRoot), readDirSafe(objRoot)]);
  const ocr = new Set(normalizeVideoIds(ocrDirs));
  const obj = new Set(normalizeVideoIds(objDirs));
  const out: string[] = [];
  for (const id of ocr) {
    if (!obj.has(id)) continue;
    if (only && !only.has(id)) continue;
    out.push(id);
  }
  out.sort((a, b) => Number(a) - Number(b));
  return out;
}

function applyShard(videoIds: string[], shardIndex: number | null, shardCount: number | null): string[] {
  if (shardIndex === null || shardCount === null) return videoIds;
  const out: string[] = [];
  for (let i = 0; i < videoIds.length; i++) {
    if (i % shardCount === shardIndex) out.push(videoIds[i]!);
  }
  return out;
}

async function scanMaxFrame(buffer: ArrayBuffer, frameColumn: string): Promise<number> {
  const metadata = await parquetMetadataAsync(buffer);
  const totalRows = Number(metadata.num_rows);
  let maxFrame = -1;
  for (let rowStart = 0; rowStart < totalRows; rowStart += FRAME_SCAN_CHUNK_ROWS) {
    const rowEnd = Math.min(totalRows, rowStart + FRAME_SCAN_CHUNK_ROWS);
    const rows = (await parquetReadObjects({
      file: buffer,
      rowStart,
      rowEnd,
      columns: [frameColumn],
      useOffsetIndex: true,
    })) as Record<string, unknown>[];
    for (const row of rows) {
      const v = num(row[frameColumn]);
      if (v !== null && v > maxFrame) maxFrame = v;
    }
  }
  return Math.floor(maxFrame);
}

function createConfigForVideo(base: ClassificationConfig, videoId: string): ClassificationConfig {
  return {
    ...base,
    video: {
      ...base.video,
      video_id: videoId,
    },
  };
}

function mkPredEvent(eventId: string, eventName: string, frame: number, idx: number): TimelineEvent {
  return {
    id: `pred_${eventId}_${frame}_${idx}`,
    kind: "point",
    event_name: eventName,
    start_frame: frame,
    end_frame: frame,
    source: "predicted",
  };
}

function maxFrame(events: TimelineEvent[]): number {
  let m = -1;
  for (const e of events) if (e.start_frame > m) m = e.start_frame;
  return m;
}

async function detectTimelineChunked(
  config: ClassificationConfig,
  ocrBuffer: ArrayBuffer,
  objectsBuffer: ArrayBuffer,
  globalMaxFrame: number,
  chunkFrames: number,
): Promise<TimelineEvent[]> {
  const overlap = computeOverlaps(config);
  const lastMatch: Record<string, number | null> = {};
  const rawPoints: TimelineEvent[] = [];
  let seq = 0;

  for (let start = 0; start <= globalMaxFrame; start += chunkFrames) {
    const end = Math.min(globalMaxFrame, start + chunkFrames - 1);
    const readStart = Math.max(0, start - overlap.past);
    const readEnd = Math.min(globalMaxFrame, end + overlap.future);

    const ocr = await loadParquetOcr(ocrBuffer, config, {
      frameRange: { startInclusive: readStart, endInclusive: readEnd },
    });
    const objects = await loadParquetObjects(objectsBuffer, config, {
      frameRange: { startInclusive: readStart, endInclusive: readEnd },
    });
    const cache = createFrameStateCache(config, ocr, objects, readEnd);

    for (let frame = readStart; frame <= end; frame++) {
      const fired = evaluateEventsAtFrame(config.events, cache, frame, lastMatch);
      for (const ev of fired) {
        lastMatch[ev.eventId] = frame;
        if (frame >= start) rawPoints.push(mkPredEvent(ev.eventId, ev.eventName, frame, seq++));
      }
    }
  }

  return collapsePredictedEvents(rawPoints, config.events);
}

async function buildEnrichedChunked(
  config: ClassificationConfig,
  ocrBuffer: ArrayBuffer,
  objectsBuffer: ArrayBuffer,
  timeline: TimelineEvent[],
  chunkFrames: number,
): Promise<EnrichedExport> {
  if (timeline.length === 0) {
    return {
      video_id: config.video.video_id,
      fps: config.video.fps,
      exported_at: new Date().toISOString(),
      events: [],
    };
  }
  const overlap = computeOverlaps(config);
  const allRecords: EnrichedExport["events"] = [];
  const maxEventFrame = maxFrame(timeline);
  const eventsSorted = [...timeline].sort((a, b) => a.start_frame - b.start_frame);
  let lo = 0;
  let hi = 0;

  for (let start = 0; start <= maxEventFrame; start += chunkFrames) {
    const end = Math.min(maxEventFrame, start + chunkFrames - 1);
    while (lo < eventsSorted.length && eventsSorted[lo]!.start_frame < start) lo++;
    if (hi < lo) hi = lo;
    while (hi < eventsSorted.length && eventsSorted[hi]!.start_frame <= end) hi++;
    if (hi <= lo) continue;
    const chunkEvents = eventsSorted.slice(lo, hi);

    const readStart = Math.max(0, start - overlap.past);
    const readEnd = end + overlap.future;
    const ocr = await loadParquetOcr(ocrBuffer, config, {
      frameRange: { startInclusive: readStart, endInclusive: readEnd },
    });
    const objects = await loadParquetObjects(objectsBuffer, config, {
      frameRange: { startInclusive: readStart, endInclusive: readEnd },
    });
    const cache = createFrameStateCache(config, ocr, objects, readEnd);
    const enriched = buildEnrichedExport(chunkEvents, config, (frame) => cache.get(frame));
    allRecords.push(...enriched.events);
  }

  allRecords.sort((a, b) => a.frame_idx - b.frame_idx);
  return {
    video_id: config.video.video_id,
    fps: config.video.fps,
    exported_at: new Date().toISOString(),
    events: allRecords,
  };
}

async function classifyVideo(baseConfig: ClassificationConfig, opts: CliOptions, videoId: string): Promise<RunSummary> {
  const t0 = performance.now();
  const folder = `video_id=${videoId}`;
  const ocrPath = path.join(opts.derivedRoot, opts.ocrSubdir, folder, opts.ocrFilename);
  const objPath = path.join(opts.derivedRoot, opts.objectsSubdir, folder, opts.objectsFilename);
  const [ocrBufNode, objBufNode] = await Promise.all([readFile(ocrPath), readFile(objPath)]);
  const ocrBuffer = toArrayBuffer(ocrBufNode);
  const objBuffer = toArrayBuffer(objBufNode);
  const config = createConfigForVideo(baseConfig, videoId);

  const ocrMaxRaw = await scanMaxFrame(ocrBuffer, config.parquet.ocr?.frame ?? "frame");
  const objMaxRaw = await scanMaxFrame(objBuffer, config.parquet.objects?.frame ?? "frame");
  const shift = frameShift(config, Math.max(ocrMaxRaw, objMaxRaw));
  const globalMax = Math.max(
    config.video.frame_count - 1,
    ocrMaxRaw >= 0 ? ocrMaxRaw - shift : -1,
    objMaxRaw >= 0 ? objMaxRaw - shift : -1,
    0,
  );

  const timeline = await detectTimelineChunked(config, ocrBuffer, objBuffer, globalMax, opts.chunkFrames);
  const enriched = await buildEnrichedChunked(config, ocrBuffer, objBuffer, timeline, opts.chunkFrames);

  const outputDir = path.join(opts.outputRoot, folder);
  const outputPath = path.join(outputDir, `${videoId}_enriched.json`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(enriched, null, 2)}\n`, "utf8");

  return {
    video_id: videoId,
    output_path: toPosix(outputPath),
    detected_events: timeline.length,
    enriched_records: enriched.events.length,
    elapsed_ms: Math.round(performance.now() - t0),
  };
}

async function runWithConcurrency(
  videoIds: string[],
  workers: number,
  runOne: (videoId: string, idx: number) => Promise<void>,
): Promise<void> {
  if (videoIds.length === 0) return;
  const concurrency = Math.min(workers, videoIds.length);
  let cursor = 0;
  const workerFn = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= videoIds.length) return;
      await runOne(videoIds[idx]!, idx);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => workerFn()));
}

async function writeManifest(opts: CliOptions, results: RunSummary[], failures: RunFailure[]): Promise<ManifestDoc> {
  const manifest: ManifestDoc = {
    generated_at: new Date().toISOString(),
    config_path: toPosix(opts.configPath),
    derived_root: toPosix(opts.derivedRoot),
    chunk_frames: opts.chunkFrames,
    workers: opts.workers,
    shard_index: opts.shardIndex,
    shard_count: opts.shardCount,
    results,
    failures,
  };
  await mkdir(opts.outputRoot, { recursive: true });
  const manifestPath = path.join(opts.outputRoot, opts.manifestName);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function parseManifest(jsonText: string): ManifestDoc {
  const data = JSON.parse(jsonText) as Partial<ManifestDoc>;
  return {
    generated_at: String(data.generated_at ?? ""),
    config_path: String(data.config_path ?? ""),
    derived_root: String(data.derived_root ?? ""),
    chunk_frames: Number(data.chunk_frames ?? 0),
    workers: Number(data.workers ?? 0),
    shard_index: data.shard_index === null || data.shard_index === undefined ? null : Number(data.shard_index),
    shard_count: data.shard_count === null || data.shard_count === undefined ? null : Number(data.shard_count),
    results: Array.isArray(data.results) ? (data.results as RunSummary[]) : [],
    failures: Array.isArray(data.failures) ? (data.failures as RunFailure[]) : [],
  };
}

function baseArgsForChild(opts: CliOptions): string[] {
  const args = [
    "--config",
    opts.configPath,
    "--derived_root",
    opts.derivedRoot,
    "--output_root",
    opts.outputRoot,
    "--ocr_subdir",
    opts.ocrSubdir,
    "--objects_subdir",
    opts.objectsSubdir,
    "--ocr_file",
    opts.ocrFilename,
    "--objects_file",
    opts.objectsFilename,
    "--chunk_frames",
    String(opts.chunkFrames),
  ];
  if (opts.onlyVideoIds && opts.onlyVideoIds.size > 0) {
    args.push("--video_ids", [...opts.onlyVideoIds].join(","));
  }
  return args;
}

async function runMultiprocess(
  opts: CliOptions,
  videoIds: string[],
): Promise<{ results: RunSummary[]; failures: RunFailure[]; childFailures: number }> {
  const shardCount = Math.min(opts.workers, videoIds.length);
  const baseArgs = baseArgsForChild(opts);
  const childManifestNames = Array.from({ length: shardCount }, (_, i) => `_manifest.worker-${i + 1}.json`);

  console.log(`Using ${shardCount} OS process(es) for video sharding.`);
  const childCodes = await Promise.all(
    childManifestNames.map(
      (manifestName, idx) =>
        new Promise<number>((resolve) => {
          const childArgs = [
            `--max-old-space-size=${CHILD_MAX_OLD_SPACE_MB}`,
            "./node_modules/tsx/dist/cli.mjs",
            "scripts/mass_classify.ts",
            ...baseArgs,
            "--workers",
            "1",
            "--manifest_name",
            manifestName,
            "--shard_index",
            String(idx),
            "--shard_count",
            String(shardCount),
          ];
          const cp = spawn(process.execPath, childArgs, {
            cwd: process.cwd(),
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          cp.stdout.on("data", (buf) => process.stdout.write(`[P${idx + 1}] ${buf.toString()}`));
          cp.stderr.on("data", (buf) => process.stderr.write(`[P${idx + 1}] ${buf.toString()}`));
          cp.on("close", (code) => resolve(code ?? 1));
        }),
    ),
  );

  const results: RunSummary[] = [];
  const failures: RunFailure[] = [];
  for (const manifestName of childManifestNames) {
    const partPath = path.join(opts.outputRoot, manifestName);
    try {
      const text = await readFile(partPath, "utf8");
      const doc = parseManifest(text);
      results.push(...doc.results);
      failures.push(...doc.failures);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ video_id: "manifest", error: `${manifestName}: ${message}` });
    } finally {
      try {
        await unlink(partPath);
      } catch {
        // No-op: temp manifest may not exist on failed child startup.
      }
    }
  }

  const childFailures = childCodes.filter((c) => c !== 0).length;
  if (childFailures > 0) {
    failures.push({
      video_id: "process",
      error: `${childFailures} child process(es) exited non-zero`,
    });
  }

  return { results, failures, childFailures };
}

async function runSingleProcess(
  opts: CliOptions,
  baseConfig: ClassificationConfig,
  targetVideoIds: string[],
): Promise<{ results: RunSummary[]; failures: RunFailure[] }> {
  const results: RunSummary[] = [];
  const failures: RunFailure[] = [];
  console.log(`Using ${Math.min(opts.workers, Math.max(1, targetVideoIds.length))} in-process worker(s).`);
  await runWithConcurrency(targetVideoIds, opts.workers, async (videoId, idx) => {
    const ordinal = `${idx + 1}/${targetVideoIds.length}`;
    try {
      console.log(`[${ordinal}] Classifying video_id=${videoId}...`);
      const s = await classifyVideo(baseConfig, opts, videoId);
      results.push(s);
      console.log(`[${ordinal}] Done video_id=${videoId} (${s.detected_events} events, ${s.elapsed_ms} ms)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ video_id: videoId, error: message });
      console.error(`[${ordinal}] Failed video_id=${videoId}: ${message}`);
    }
  });
  return { results, failures };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  opts.chunkFrames = intAtLeast("chunk_frames", opts.chunkFrames, 1);
  opts.workers = intAtLeast("workers", opts.workers, 1);
  opts.manifestName = normalizeManifestName(opts.manifestName);
  validateShardArgs(opts);

  const rawCfg = await readFile(opts.configPath, "utf8");
  const baseConfig = classificationConfigSchema.parse(JSON.parse(rawCfg) as unknown);
  const ocrRoot = path.join(opts.derivedRoot, opts.ocrSubdir);
  const objRoot = path.join(opts.derivedRoot, opts.objectsSubdir);
  const allVideoIds = await discoverVideoIds(ocrRoot, objRoot, opts.onlyVideoIds);
  if (allVideoIds.length === 0) throw new Error("No matching video_id folders found.");

  const targetVideoIds = applyShard(allVideoIds, opts.shardIndex, opts.shardCount);
  const isRootMultiprocessRun = opts.shardIndex === null && opts.shardCount === null && opts.workers > 1;

  console.log(`Found ${allVideoIds.length} video IDs total.`);
  if (opts.shardIndex !== null && opts.shardCount !== null) {
    console.log(`Shard ${opts.shardIndex + 1}/${opts.shardCount} will process ${targetVideoIds.length} IDs.`);
  } else {
    console.log(`Processing ${targetVideoIds.length} IDs.`);
  }

  let results: RunSummary[] = [];
  let failures: RunFailure[] = [];
  let childFailures = 0;
  if (isRootMultiprocessRun) {
    const multi = await runMultiprocess(opts, allVideoIds);
    results = multi.results;
    failures = multi.failures;
    childFailures = multi.childFailures;
  } else {
    const single = await runSingleProcess(opts, baseConfig, targetVideoIds);
    results = single.results;
    failures = single.failures;
  }

  await writeManifest(opts, results, failures);
  console.log(`Wrote manifest: ${toPosix(path.join(opts.outputRoot, opts.manifestName))}`);
  console.log(`Completed: ${results.length} succeeded, ${failures.length} failed.`);
  if (failures.length > 0 || childFailures > 0) {
    process.exitCode = 1;
  }
}

void main();
