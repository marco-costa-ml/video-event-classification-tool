import { describe, expect, it } from "vitest";
import { buildForwardReconstruction } from "@/domain/forwardReconstruction";
import { reconstructFrameState } from "@/domain/frameReconstruction";
import type { ClassificationConfig } from "@/schemas";
import type { LoadedParquetSlice, ObjectBox } from "@/domain/types";

function objSlice(frames: number[], perFrame: ObjectBox[][]): LoadedParquetSlice {
  return { role: "objects", frames, rows: perFrame };
}

const objectBox: ObjectBox = {
  id: "o1",
  className: "person",
  score: 1,
  x: 10,
  y: 10,
  w: 10,
  h: 10,
  metadata: {},
};

const config: ClassificationConfig = {
  version: 1,
  video: { video_id: "test", fps: 30, frame_count: 10, width: 100, height: 100 },
  parquet: {},
  ocr_label_placements: [],
  reconstruction: { object_ttl_frames: 2, ocr_ttl_frames: 5 },
  zones: [
    {
      id: "zone_a",
      name: "Zone A",
      priority: 1,
      geometry: { type: "rectangle", x: 0, y: 0, width: 50, height: 50 },
      parent_classes: [],
      object_classes: [],
      object_class_ranges: [],
    },
    {
      id: "zone_b",
      name: "Zone B",
      priority: 2,
      geometry: { type: "rectangle", x: 0, y: 0, width: 50, height: 50 },
      parent_classes: [],
      object_classes: [],
      object_class_ranges: [],
    },
  ],
  pages: [],
  events: [],
};

describe("reconstructFrameState zones", () => {
  it("keeps exclusive priority assignment and physical zone membership separate", () => {
    const objects = objSlice([0], [[objectBox]]);
    const forward = buildForwardReconstruction(null, objects, 5, 2, 9);
    const st = reconstructFrameState(0, config, null, objects, null, forward);

    expect(st.zone_summary.zone_b?.object_ids).toEqual(["o1"]);
    expect(st.zone_summary.zone_a?.object_ids).toEqual([]);
    expect(st.zone_membership_summary.zone_b?.object_ids).toEqual(["o1"]);
    expect(st.zone_membership_summary.zone_a?.object_ids).toEqual(["o1"]);
    expect(st.value_root.zone_membership).toBe(st.zone_membership_summary);
  });
});
