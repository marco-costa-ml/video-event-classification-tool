import type { EvaluationReport } from "@/evaluation/metrics";
import type { ClassificationConfig } from "@/schemas";
import type { PredicateNode, ValueExpr } from "@/schemas/predicates";
import type { FieldPath } from "@/schemas/fieldPath";
import type { FrameState, ObjectBox } from "@/domain/types";
import type { TimelineEvent } from "@/schemas/labels";

function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportClassificationJson(config: ClassificationConfig, filename = "classification.json") {
  downloadText(filename, JSON.stringify(config, null, 2), "application/json");
}

export function exportTimelineJson(events: TimelineEvent[], filename: string) {
  downloadText(filename, JSON.stringify(events, null, 2), "application/json");
}

export function exportEvaluationReport(report: EvaluationReport, filename = "evaluation_report.json") {
  downloadText(filename, JSON.stringify(report, null, 2), "application/json");
}

/**
 * Browser-native Parquet writing is intentionally isolated. Today this exports JSONL
 * with the same logical columns an offline tool can turn into Parquet.
 */
export function exportEventsAsJsonlForParquetPipeline(events: TimelineEvent[], filename = "events.jsonl") {
  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  downloadText(filename, lines, "application/x-ndjson");
}

// ─── Enriched export (state-aware, for DL training) ──────────────────────────

/** Walk a predicate tree and collect every zone id and OCR label it references. */
function collectPredicateRefs(
  node: PredicateNode,
  zoneIds: Set<string>,
  ocrLabels: Set<string>,
) {
  function fromPath(path: FieldPath) {
    if (path[0] === "zones" && typeof path[1] === "string") zoneIds.add(path[1]);
    if (path[0] === "ocr" && path[1] === "by_label" && typeof path[2] === "string") ocrLabels.add(path[2]);
  }
  function fromExpr(expr: ValueExpr) {
    if (expr.kind === "field" || expr.kind === "window_field") fromPath(expr.path);
  }
  function walk(n: PredicateNode) {
    switch (n.kind) {
      case "logical":    for (const c of n.children) walk(c); break;
      case "comparison": fromExpr(n.left); fromExpr(n.right); break;
      case "exists":
      case "not_exists": fromPath(n.path); break;
      case "change":     fromPath(n.path); break;
      case "aggregate":  fromPath(n.path); if (n.filter) walk(n.filter); break;
      case "temporal":   walk(n.child); break;
    }
  }
  walk(node);
}

type EnrichedChildren = Record<string, number | string | null>;

type EnrichedObject = {
  class_id: number | string;
  bbox: [number, number, number, number];
  score: number | null;
  provenance: string;
  children: EnrichedChildren;
};

type EnrichedStateSnapshot = {
  zones: Record<string, EnrichedObject[]>;
  ocr: Record<string, string | number | null>;
};

type EnrichedAction = { type: string; event_id: string };

type EnrichedEventRecord = {
  frame_idx: number;
  page_id: string | null;
  page_name: string | null;
  state: EnrichedStateSnapshot;
  actions: EnrichedAction[];
};

export type EnrichedExport = {
  video_id: string;
  fps: number;
  exported_at: string;
  events: EnrichedEventRecord[];
};

function toEnrichedObject(obj: ObjectBox): EnrichedObject {
  const children: EnrichedChildren = {};
  for (const [k, v] of Object.entries(obj.metadata)) {
    if (k === "page_hint") continue;
    children[k] =
      v === null || v === undefined ? null
      : typeof v === "number" || typeof v === "string" ? v
      : null;
  }
  const classIdNum = Number(obj.className);
  return {
    class_id: Number.isInteger(classIdNum) && Number.isFinite(classIdNum) ? classIdNum : obj.className,
    bbox: [obj.x, obj.y, obj.x + obj.w, obj.y + obj.h],
    score: obj.score,
    provenance: obj.provenance ?? "observed",
    children,
  };
}

function ocrTextToValue(text: string | undefined): string | number | null {
  if (text === undefined || text === "" || text === "NaN") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : text;
}

/**
 * Build an enriched export document for a set of events.
 *
 * For each event frame:
 *  - Finds the active page and walks its match predicate to discover which
 *    zones and OCR labels are contextually relevant.
 *  - Falls back to ALL configured zones when no page is active.
 *  - Packages zone occupancy (with object children from parquet metadata),
 *    OCR snapshot, and the list of actions into a single record.
 */
export function buildEnrichedExport(
  events: TimelineEvent[],
  config: ClassificationConfig,
  stateAt: (frame: number) => FrameState,
): EnrichedExport {
  // Group events by frame so multiple simultaneous actions collapse into one record
  const byFrame = new Map<number, TimelineEvent[]>();
  for (const ev of events) {
    const f = ev.start_frame;
    if (!byFrame.has(f)) byFrame.set(f, []);
    byFrame.get(f)!.push(ev);
  }

  const records: EnrichedEventRecord[] = [];

  for (const frame of [...byFrame.keys()].sort((a, b) => a - b)) {
    const eventsAtFrame = byFrame.get(frame)!;
    const st = stateAt(frame);

    // Discover relevant zones and OCR labels from the active page's predicate
    const zoneIds = new Set<string>();
    const ocrLabels = new Set<string>();
    const pageConfig = st.active_page
      ? config.pages.find((p) => p.id === st.active_page!.id)
      : null;

    if (pageConfig?.match) {
      collectPredicateRefs(pageConfig.match, zoneIds, ocrLabels);
    }
    // Fall back to all configured zones when there is no page (or page has no zone refs)
    if (zoneIds.size === 0) {
      for (const z of config.zones) zoneIds.add(z.id);
    }

    // Build zone state
    const objById = new Map<string, ObjectBox>(st.objects.map((o) => [o.id, o]));
    const zonesState: Record<string, EnrichedObject[]> = {};
    for (const zoneId of zoneIds) {
      const summary = st.zone_summary[zoneId];
      zonesState[zoneId] = summary
        ? summary.object_ids
            .map((id) => objById.get(id))
            .filter((o): o is ObjectBox => o !== undefined)
            .map(toEnrichedObject)
        : [];
    }

    // Build OCR state
    const ocrState: Record<string, string | number | null> = {};
    for (const label of ocrLabels) {
      ocrState[label] = ocrTextToValue(st.ocr_by_label[label]?.[0]?.text);
    }

    records.push({
      frame_idx: frame,
      page_id: st.active_page?.id ?? null,
      page_name: st.active_page?.name ?? null,
      state: { zones: zonesState, ocr: ocrState },
      actions: eventsAtFrame.map((ev) => ({ type: ev.event_name, event_id: ev.id })),
    });
  }

  return {
    video_id: config.video.video_id,
    fps: config.video.fps,
    exported_at: new Date().toISOString(),
    events: records,
  };
}

export function exportEnrichedJson(
  events: TimelineEvent[],
  config: ClassificationConfig,
  stateAt: (frame: number) => FrameState,
  filename = "enriched_events.json",
) {
  const data = buildEnrichedExport(events, config, stateAt);
  downloadText(filename, JSON.stringify(data, null, 2), "application/json");
}
