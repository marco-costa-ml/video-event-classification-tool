import { parquetReadObjects } from "hyparquet";
import type { ClassificationConfig, ParquetColumnMap } from "@/schemas";
import type { LoadedParquetSlice, ObjectBox, OcrBox } from "@/domain/types";
import { maxFramesForWindow } from "@/domain/timelineWindow";
import { inferBBox, inferFrameColumn, resolveObjectsColumnMap, resolveOcrColumnMap } from "@/services/parquetColumnInfer";

/** Rows read only to infer columns + frame type (not full dataset). */
const PARQUET_SAMPLE_ROW_END = 25_000;

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

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function getCol(row: Record<string, unknown>, key: string | undefined): unknown {
  if (!key) return undefined;
  return row[key];
}

function mapColumnNames(map: ParquetColumnMap): string[] {
  const keys: (keyof ParquetColumnMap)[] = [
    "frame",
    "timestamp_ms",
    "ocr_label",
    "ocr_text",
    "ocr_x",
    "ocr_y",
    "ocr_w",
    "ocr_h",
    "ocr_confidence",
    "object_id",
    "object_class",
    "object_score",
    "bbox_x",
    "bbox_y",
    "bbox_w",
    "bbox_h",
    "page_hint",
  ];
  const out: string[] = [];
  for (const k of keys) {
    const v = map[k];
    if (typeof v === "string" && v.length) out.push(v);
  }
  return [...new Set(out)];
}

function collectProjectedColumns(map: ParquetColumnMap, sampleRows: Record<string, unknown>[]): string[] {
  const s = new Set(mapColumnNames(map));
  for (const r of sampleRows.slice(0, 800)) {
    for (const k of Object.keys(r)) s.add(k);
  }
  return [...s];
}

/**
 * Parquet may store `frame` as INT64 → bigint. hyparquet filters compare with JS `<=`; mixed bigint/number throws.
 */
function frameUpperBoundForFilter(
  maxFrameInclusive: number,
  sampleRows: Record<string, unknown>[],
  frameCol: string,
): number | bigint {
  for (const r of sampleRows) {
    const v = r[frameCol];
    if (v === undefined || v === null) continue;
    if (typeof v === "bigint") return BigInt(maxFrameInclusive);
    return maxFrameInclusive;
  }
  return maxFrameInclusive;
}

/**
 * Reads parquet rows for the UI workbench window only (first N minutes by frame index),
 * using hyparquet row-group skipping via `filter` so multi-hour files do not materialize fully in memory.
 */
async function readParquetRowsForConfig(
  buffer: ArrayBuffer,
  config: ClassificationConfig,
  mapBase: ParquetColumnMap,
  resolveMap: (rows: Record<string, unknown>[], user: ParquetColumnMap) => ParquetColumnMap,
): Promise<{ rows: Record<string, unknown>[]; map: ParquetColumnMap }> {
  const sample = (await parquetReadObjects({
    file: buffer,
    rowStart: 0,
    rowEnd: PARQUET_SAMPLE_ROW_END,
    useOffsetIndex: true,
  })) as Record<string, unknown>[];

  const map = resolveMap(sample, mapBase);
  const frameCol = map.frame;
  if (!frameCol) {
    throw new Error("Parquet: could not resolve a frame column (check config.parquet column map).");
  }

  const maxFrameInclusive = maxFramesForWindow(config.video.fps) - 1;
  const bound = frameUpperBoundForFilter(maxFrameInclusive, sample, frameCol);
  const filter = { [frameCol]: { $lte: bound } } as const;
  const columns = collectProjectedColumns(map, sample);

  const baseOpts = { file: buffer, filter, useOffsetIndex: true as const };

  try {
    const rows = (await parquetReadObjects({
      ...baseOpts,
      columns,
    })) as Record<string, unknown>[];
    return { rows, map };
  } catch {
    // Wider projection if a needed field was missing from the sample rows.
    const rows = (await parquetReadObjects(baseOpts)) as Record<string, unknown>[];
    return { rows, map };
  }
}

function readBBox(row: Record<string, unknown>, map: ParquetColumnMap): { x: number; y: number; w: number; h: number } | null {
  if (map.bbox_x && map.bbox_y && map.bbox_w && map.bbox_h) {
    const x = num(getCol(row, map.bbox_x));
    const y = num(getCol(row, map.bbox_y));
    const w = num(getCol(row, map.bbox_w));
    const h = num(getCol(row, map.bbox_h));
    if (x !== null && y !== null && w !== null && h !== null && w > 0 && h > 0) {
      return { x, y, w, h };
    }
  }
  return inferBBox(row);
}

function parseOcrRows(
  rows: Record<string, unknown>[],
  map: ParquetColumnMap,
): { frames: number[]; data: OcrBox[] } {
  const frames: number[] = [];
  const data: OcrBox[] = [];
  const fallbackFrame = inferFrameColumn(rows);
  for (const row of rows) {
    let f = num(getCol(row, map.frame));
    if (f === null && fallbackFrame) f = num(row[fallbackFrame]);
    if (f === null) continue;
    const frame = Math.round(f);
    let x = map.ocr_x ? (num(getCol(row, map.ocr_x)) ?? 0) : 0;
    let y = map.ocr_y ? (num(getCol(row, map.ocr_y)) ?? 0) : 0;
    let w = map.ocr_w ? (num(getCol(row, map.ocr_w)) ?? 0) : 0;
    let h = map.ocr_h ? (num(getCol(row, map.ocr_h)) ?? 0) : 0;
    if ((w <= 0 || h <= 0) && inferBBox(row)) {
      const b = inferBBox(row)!;
      x = b.x;
      y = b.y;
      w = b.w;
      h = b.h;
    }
    frames.push(frame);
    data.push({
      label: (map.ocr_label ? str(getCol(row, map.ocr_label)) : null) ?? "",
      text: (map.ocr_text ? str(getCol(row, map.ocr_text)) : null) ?? "",
      x,
      y,
      w,
      h,
      confidence: map.ocr_confidence ? num(getCol(row, map.ocr_confidence)) : null,
    });
  }
  return { frames, data };
}

function parseObjectRows(
  rows: Record<string, unknown>[],
  map: ParquetColumnMap,
): { frames: number[]; data: ObjectBox[] } {
  const frames: number[] = [];
  const data: ObjectBox[] = [];
  const fallbackFrame = inferFrameColumn(rows);
  // Pre-compute the set of physical column names already covered by the standard map,
  // so we can capture all remaining columns (edition_class_id, sticker_class_id, etc.) as children.
  const standardMappedCols = new Set<string>(
    Object.values(map).filter((v): v is string => typeof v === "string" && v.length > 0),
  );
  for (const row of rows) {
    let f = num(getCol(row, map.frame));
    if (f === null && fallbackFrame) f = num(row[fallbackFrame]);
    if (f === null) continue;
    const frame = Math.round(f);
    const bbox = readBBox(row, map);
    const x = bbox?.x ?? 0;
    const y = bbox?.y ?? 0;
    const w = bbox?.w ?? 0;
    const h = bbox?.h ?? 0;
    const id =
      (map.object_id ? str(getCol(row, map.object_id)) : null) ?? `obj_${frame}_${data.length}`;
    const meta: Record<string, unknown> = {};
    if (map.page_hint) {
      const ph = getCol(row, map.page_hint);
      if (ph !== undefined) meta.page_hint = ph;
    }
    // Capture all extra columns not covered by the standard column map as children metadata
    // (e.g. edition_class_id, sticker_class_id, modifier_class_id from parent–child parquet schemas)
    for (const [k, v] of Object.entries(row)) {
      if (standardMappedCols.has(k)) continue;
      meta[k] = v === null || v === undefined ? null : typeof v === "bigint" ? Number(v) : v;
    }
    data.push({
      id,
      className: (map.object_class ? str(getCol(row, map.object_class)) : null) ?? "",
      score: map.object_score ? num(getCol(row, map.object_score)) : null,
      x,
      y,
      w,
      h,
      metadata: meta,
    });
    frames.push(frame);
  }
  return { frames, data };
}

function sortAndMergeFrames<T>(frames: number[], data: T[]): { frames: number[]; rows: T[][] } {
  const order = frames.map((_, i) => i).sort((a, b) => frames[a]! - frames[b]!);
  const mergedFrames: number[] = [];
  const mergedRows: T[][] = [];
  for (const i of order) {
    const fr = frames[i]!;
    const row = data[i]!;
    if (mergedFrames.length && mergedFrames[mergedFrames.length - 1] === fr) {
      mergedRows[mergedRows.length - 1]!.push(row);
    } else {
      mergedFrames.push(fr);
      mergedRows.push([row]);
    }
  }
  return { frames: mergedFrames, rows: mergedRows };
}

export async function loadParquetOcr(
  buffer: ArrayBuffer,
  config: ClassificationConfig,
): Promise<LoadedParquetSlice | null> {
  const mapBase = config.parquet.ocr;
  if (!mapBase) return null;
  const { rows, map } = await readParquetRowsForConfig(buffer, config, mapBase, resolveOcrColumnMap);
  const parsed = parseOcrRows(rows, map);
  const sorted = sortAndMergeFrames(parsed.frames, parsed.data);
  return {
    role: "ocr",
    frames: sorted.frames,
    rows: sorted.rows,
  };
}

export async function loadParquetObjects(
  buffer: ArrayBuffer,
  config: ClassificationConfig,
): Promise<LoadedParquetSlice | null> {
  const mapBase = config.parquet.objects;
  if (!mapBase) return null;
  const { rows, map } = await readParquetRowsForConfig(buffer, config, mapBase, resolveObjectsColumnMap);
  const parsed = parseObjectRows(rows, map);
  const sorted = sortAndMergeFrames(parsed.frames, parsed.data);
  return {
    role: "objects",
    frames: sorted.frames,
    rows: sorted.rows,
  };
}
