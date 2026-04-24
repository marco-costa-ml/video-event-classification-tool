import { classificationConfigSchema, type ClassificationConfig } from "@/schemas";
import type { LoadedParquetSlice, OcrBox, ObjectBox } from "@/domain/types";

const rawConfig = {
  version: 1,
  video: {
    video_id: "sample_001",
    fps: 30,
    frame_count: 300,
    width: 640,
    height: 360,
  },
  parquet: {
    ocr: {
      frame: "frame",
      ocr_label: "label",
      ocr_text: "text",
      ocr_x: "x",
      ocr_y: "y",
      ocr_w: "w",
      ocr_h: "h",
      ocr_confidence: "confidence",
    },
    objects: {
      frame: "frame",
      object_id: "object_id",
      object_class: "class",
      object_score: "score",
      bbox_x: "x",
      bbox_y: "y",
      bbox_w: "w",
      bbox_h: "h",
    },
  },
  ocr_label_placements: [{ label: "title", anchor: "top_left" as const, offset_x: 0, offset_y: 0 }],
  zones: [
    {
      id: "z_roi",
      name: "ROI",
      priority: 10,
      geometry: { type: "rectangle" as const, x: 100, y: 80, width: 900, height: 520 },
      parent_classes: [],
      object_classes: ["person", "vehicle"],
    },
  ],
  pages: [
    {
      id: "p_home",
      name: "Home",
      priority: 10,
      match: {
        kind: "comparison",
        left: { kind: "field", path: ["class_counts", "person"] },
        op: ">=",
        right: { kind: "literal", value: 0 },
      },
    },
  ],
  events: [
    {
      id: "ev_person_roi",
      name: "person_in_roi",
      priority: 10,
      predicate: {
        kind: "comparison",
        left: { kind: "field", path: ["zones", "z_roi", "occupancy"] },
        op: ">",
        right: { kind: "literal", value: 0 },
      },
      dedupe: { merge_adjacent_frames: 3, strategy: "leading_edge" as const },
    },
  ],
} satisfies Record<string, unknown>;

export const SAMPLE_CONFIG: ClassificationConfig = classificationConfigSchema.parse(rawConfig);

function buildSparseFromRows<T>(
  role: "ocr" | "objects",
  rows: { frame: number; payload: T }[],
): LoadedParquetSlice {
  const sorted = [...rows].sort((a, b) => a.frame - b.frame);
  const frames: number[] = [];
  const merged: T[][] = [];
  for (const r of sorted) {
    if (frames.length && frames[frames.length - 1] === r.frame) {
      merged[merged.length - 1]!.push(r.payload);
    } else {
      frames.push(r.frame);
      merged.push([r.payload]);
    }
  }
  return { role, frames, rows: merged };
}

export const SAMPLE_OCR: LoadedParquetSlice = buildSparseFromRows<OcrBox>("ocr", [
  { frame: 0, payload: { label: "title", text: "Dashboard", x: 120, y: 40, w: 200, h: 24, confidence: 0.92 } },
  { frame: 30, payload: { label: "title", text: "Dashboard", x: 120, y: 40, w: 200, h: 24, confidence: 0.9 } },
  { frame: 120, payload: { label: "title", text: "Alerts", x: 120, y: 40, w: 120, h: 24, confidence: 0.88 } },
]);

export const SAMPLE_OBJECTS: LoadedParquetSlice = buildSparseFromRows<ObjectBox>("objects", [
  { frame: 10, payload: { id: "o1", className: "person", score: 0.9, x: 200, y: 200, w: 80, h: 200, metadata: {} } },
  { frame: 11, payload: { id: "o1", className: "person", score: 0.91, x: 205, y: 200, w: 80, h: 200, metadata: {} } },
  { frame: 40, payload: { id: "o1", className: "person", score: 0.89, x: 300, y: 210, w: 82, h: 198, metadata: {} } },
  { frame: 130, payload: { id: "o2", className: "vehicle", score: 0.8, x: 500, y: 400, w: 200, h: 120, metadata: {} } },
]);
