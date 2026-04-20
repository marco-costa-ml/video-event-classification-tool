import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "@/schemas/labels";
import { collapseAdjacentByName, collapsePredictedEvents } from "@/domain/eventDedupe";
import type { EventDefinition } from "@/schemas";

function point(name: string, frame: number, id: string): TimelineEvent {
  return { id, kind: "point", event_name: name, start_frame: frame, source: "predicted" };
}

describe("collapseAdjacentByName", () => {
  it("merges within window", () => {
    const evs = [point("a", 0, "1"), point("a", 1, "2"), point("a", 5, "3")];
    const out = collapseAdjacentByName(evs, 2);
    expect(out.map((e) => e.start_frame)).toEqual([0, 5]);
  });
});

describe("collapsePredictedEvents", () => {
  it("uses per-event dedupe window from definitions", () => {
    const defs: EventDefinition[] = [
      {
        id: "e1",
        name: "a",
        priority: 1,
        predicate: { kind: "logical", op: "and", children: [] },
        dedupe: { merge_adjacent_frames: 5, strategy: "leading_edge" },
      },
    ];
    const evs = [point("a", 0, "1"), point("a", 3, "2")];
    const out = collapsePredictedEvents(evs, defs);
    expect(out).toHaveLength(1);
  });
});
