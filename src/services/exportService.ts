import type { EvaluationReport } from "@/evaluation/metrics";
import type { ClassificationConfig } from "@/schemas";
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

type EnrichedChildren = Record<string, number | string | null>;

type EnrichedObject = {
  class_id: number | string;
  bbox: [number, number, number, number];
  score: number | null;
  provenance: string;
  position_in_zone: number;
  children: EnrichedChildren;
};

type EnrichedStateSnapshot = {
  zones: Record<string, EnrichedObject[]>;
  ocr: Record<string, string | number | null>;
};

type EnrichedAction = { id: string; type: string };

type EnrichedEventRecord = {
  frame_idx: number;
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

function toEnrichedObject(obj: ObjectBox, position_in_zone: number): EnrichedObject {
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
    position_in_zone,
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
 *  - Uses the active page's export filters (zones + OCR labels) when available.
 *    If a page omits filters, defaults to exporting all zones / OCR labels.
 *  - Zone objects come from physical occupancy (zone_membership_summary), not
 *    exclusive highest-priority assignment.
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
    const pageConfig = st.active_page
      ? config.pages.find((p) => p.id === st.active_page!.id)
      : null;

    // Zone export filters (page-scoped)
    const zoneIds = new Set<string>();
    if (pageConfig?.export_include_zone_ids) {
      for (const id of pageConfig.export_include_zone_ids) zoneIds.add(id);
    } else {
      for (const z of config.zones) zoneIds.add(z.id);
    }

    // Map zone id → zone name for output keying
    const zoneIdToName = new Map(config.zones.map((z) => [z.id, z.name]));

    // Build zone state (keyed by zone name, with position_in_zone by left-to-right order)
    const objById = new Map<string, ObjectBox>(st.objects.map((o) => [o.id, o]));
    const zonesState: Record<string, EnrichedObject[]> = {};
    for (const zoneId of zoneIds) {
      const zoneName = zoneIdToName.get(zoneId) ?? zoneId;
      // Use physical occupancy (all objects physically in zone, class filters already applied upstream).
      const summary = st.zone_membership_summary[zoneId];
      if (!summary) {
        zonesState[zoneName] = [];
        continue;
      }
      const objs = summary.object_ids
        .map((id) => objById.get(id))
        .filter((o): o is ObjectBox => o !== undefined);
      // Assign position_in_zone by ascending x (leftmost = 0)
      const sortedByX = [...objs].sort((a, b) => a.x - b.x);
      const positionOf = new Map(sortedByX.map((o, i) => [o.id, i]));
      zonesState[zoneName] = objs.map((o) => toEnrichedObject(o, positionOf.get(o.id) ?? 0));
    }

    // OCR export filters (page-scoped)
    const ocrState: Record<string, string | number | null> = {};
    const ocrLabels = pageConfig?.export_include_ocr_labels
      ? pageConfig.export_include_ocr_labels
      : Object.keys(st.ocr_by_label);
    for (const label of ocrLabels) {
      ocrState[label] = ocrTextToValue(st.ocr_by_label[label]?.[0]?.text);
    }

    records.push({
      frame_idx: frame,
      page_name: st.active_page?.name ?? null,
      state: { zones: zonesState, ocr: ocrState },
      actions: eventsAtFrame.map((ev) => ({ id: ev.id, type: ev.event_name })),
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
