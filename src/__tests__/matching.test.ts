import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "@/schemas/labels";
import { matchEventsOneToOne } from "@/evaluation/matching";
import { evaluateTimeline } from "@/evaluation/metrics";

function point(name: string, frame: number, id: string): TimelineEvent {
  return { id, kind: "point", event_name: name, start_frame: frame, source: "manual" };
}

describe("matchEventsOneToOne", () => {
  it("matches at most one-to-one within tolerance", () => {
    const manual = [point("a", 10, "m1"), point("a", 50, "m2")];
    const pred = [
      { ...point("a", 11, "p1"), source: "predicted" as const },
      { ...point("a", 51, "p2"), source: "predicted" as const },
    ];
    const { pairs, unmatchedManual, unmatchedPred } = matchEventsOneToOne(manual, pred, { tolerance: 2 });
    expect(pairs).toHaveLength(2);
    expect(unmatchedManual).toHaveLength(0);
    expect(unmatchedPred).toHaveLength(0);
    expect(Math.abs(pairs[0]!.temporalErrorFrames)).toBeLessThanOrEqual(2);
    const used = new Set<string>();
    for (const p of pairs) {
      expect(used.has(p.predicted.id)).toBe(false);
      used.add(p.predicted.id);
    }
  });
});

describe("evaluateTimeline", () => {
  it("computes counts and F1", () => {
    const manual = [point("a", 10, "m1")];
    const pred = [{ ...point("a", 20, "p1"), source: "predicted" as const }];
    const rep = evaluateTimeline(manual, pred, 15);
    expect(rep.overall.manual_count).toBe(1);
    expect(rep.overall.predicted_count).toBe(1);
    expect(rep.overall.matched).toBe(1);
    expect(rep.overall.f1).toBeGreaterThan(0);
  });
});
