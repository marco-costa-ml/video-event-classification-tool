import { describe, expect, it } from "vitest";
import { classificationConfigSchema } from "@/schemas";
import { SAMPLE_CONFIG } from "@/data/builtinSample";

describe("classificationConfigSchema", () => {
  it("parses built-in sample config", () => {
    const cfg = classificationConfigSchema.parse(SAMPLE_CONFIG);
    expect(cfg.video.fps).toBeGreaterThan(0);
    expect(cfg.events.length).toBeGreaterThan(0);
  });
});
