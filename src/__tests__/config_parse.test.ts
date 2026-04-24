import { describe, expect, it } from "vitest";
import { classificationConfigSchema } from "@/schemas";
import { SAMPLE_CONFIG } from "@/data/builtinSample";

describe("classificationConfigSchema", () => {
  it("parses built-in sample config", () => {
    const cfg = classificationConfigSchema.parse(SAMPLE_CONFIG);
    expect(cfg.video.fps).toBeGreaterThan(0);
    expect(cfg.events.length).toBeGreaterThan(0);
  });

  it("parses zones with object_class_ranges (min/max normalized)", () => {
    const cfg = classificationConfigSchema.parse({
      ...SAMPLE_CONFIG,
      zones: [
        {
          id: "z1",
          name: "R",
          priority: 1,
          geometry: { type: "rectangle", x: 0, y: 0, width: 10, height: 10 },
          parent_classes: [],
          object_classes: [],
          object_class_ranges: [{ min: 399, max: 370 }, { min: 120, max: 120 }],
        },
      ],
    });
    expect(cfg.zones[0]!.object_class_ranges).toEqual([
      { min: 370, max: 399 },
      { min: 120, max: 120 },
    ]);
  });
});
