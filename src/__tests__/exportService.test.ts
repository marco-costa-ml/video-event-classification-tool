import { describe, expect, it } from "vitest";
import type { FrameState, ObjectBox } from "@/domain/types";
import type { ClassificationConfig } from "@/schemas";
import type { TimelineEvent } from "@/schemas/labels";
import { buildEnrichedExport } from "@/services/exportService";

function baseState(overrides: Partial<FrameState> = {}): FrameState {
  const st: FrameState = {
    frame: 5,
    timestamp_ms: 0,
    missing: { ocr: false, objects: false },
    reconstruction_stats: {
      ocr: { observed: 0, carried: 0 },
      objects: { observed: 0, carried: 0, dropped_ttl: 0 },
    },
    sparse_observation: { ocr: true, objects: true },
    active_page: { id: "p1", name: "P1" },
    zone_summary: {},
    zone_membership_summary: {},
    object_primary_zone: {},
    ocr_boxes: [],
    ocr_by_label: {},
    objects: [],
    class_counts: {},
    value_root: {},
    ...overrides,
  };
  st.value_root = {
    frame: st.frame,
    timestamp_ms: st.timestamp_ms,
    page: st.active_page,
    zones: st.zone_summary,
    zone_membership: st.zone_membership_summary,
    object_primary_zone: st.object_primary_zone,
    ocr: { by_label: st.ocr_by_label, boxes: st.ocr_boxes },
    objects: st.objects,
    class_counts: st.class_counts,
    reconstruction: st.reconstruction_stats,
  };
  return st;
}

describe("buildEnrichedExport zone membership", () => {
  it("exports overlapping-zone objects from physical membership, not exclusive priority", () => {
    const obj: ObjectBox = {
      id: "o1",
      className: "10",
      score: 0.9,
      x: 10,
      y: 10,
      w: 10,
      h: 10,
      metadata: {},
    };

    const config: ClassificationConfig = {
      version: 1,
      video: { video_id: "vid", fps: 30, frame_count: 100, width: 100, height: 100 },
      parquet: {},
      ocr_label_placements: [{ label: "fruits", anchor: "top_left", offset_x: 0, offset_y: 0 }],
      reconstruction: { object_ttl_frames: 2, ocr_ttl_frames: 5 },
      zones: [
        {
          id: "z1",
          name: "Zone A",
          priority: 1,
          geometry: { type: "rectangle", x: 0, y: 0, width: 50, height: 50 },
          parent_classes: [],
          object_classes: [],
          object_class_ranges: [{ min: 10, max: 10 }],
        },
        {
          id: "z2",
          name: "Zone B",
          priority: 2,
          geometry: { type: "rectangle", x: 0, y: 0, width: 50, height: 50 },
          parent_classes: [],
          object_classes: [],
          object_class_ranges: [{ min: 10, max: 10 }],
        },
      ],
      pages: [
        {
          id: "p1",
          name: "P1",
          priority: 1,
          match: { kind: "logical", op: "and", children: [] },
          export_include_zone_ids: ["z1", "z2"],
          export_include_ocr_labels: ["fruits"],
        },
      ],
      events: [],
    };

    const st = baseState({
      frame: 5,
      active_page: { id: "p1", name: "P1" },
      objects: [obj],
      // Exclusive assignment would keep object only in higher-priority z2.
      zone_summary: {
        z1: { name: "Zone A", priority: 1, occupancy: 0, object_ids: [] },
        z2: { name: "Zone B", priority: 2, occupancy: 1, object_ids: ["o1"] },
      },
      // Physical membership must include object in both overlapping zones.
      zone_membership_summary: {
        z1: { name: "Zone A", priority: 1, occupancy: 1, object_ids: ["o1"] },
        z2: { name: "Zone B", priority: 2, occupancy: 1, object_ids: ["o1"] },
      },
      ocr_by_label: { fruits: [{ label: "fruits", text: "apple", x: 0, y: 0, w: 1, h: 1, confidence: 1 }] },
    });

    const events: TimelineEvent[] = [
      { id: "e1", kind: "point", event_name: "evt", start_frame: 5, source: "predicted" },
    ];

    const out = buildEnrichedExport(events, config, () => st);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.state.zones["Zone A"]).toHaveLength(1);
    expect(out.events[0]!.state.zones["Zone B"]).toHaveLength(1);
    expect(out.events[0]!.state.zones["Zone A"]![0]!.class_id).toBe(10);
  });
});
