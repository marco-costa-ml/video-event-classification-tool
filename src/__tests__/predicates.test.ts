import { describe, expect, it } from "vitest";
import type { FrameState } from "@/domain/types";
import { evaluatePredicate, evalComparisonOp } from "@/domain/predicateEval";
import type { PredicateNode } from "@/schemas";

function buildValueRoot(
  st: Pick<
    FrameState,
    | "frame"
    | "timestamp_ms"
    | "active_page"
    | "zone_summary"
    | "object_primary_zone"
    | "ocr_boxes"
    | "ocr_by_label"
    | "objects"
    | "class_counts"
    | "reconstruction_stats"
    | "sparse_observation"
  >,
): Record<string, unknown> {
  return {
    frame: st.frame,
    timestamp_ms: st.timestamp_ms,
    page: st.active_page,
    zones: st.zone_summary,
    object_primary_zone: st.object_primary_zone,
    ocr: { by_label: st.ocr_by_label, boxes: st.ocr_boxes },
    objects: st.objects,
    class_counts: st.class_counts,
    reconstruction: st.reconstruction_stats,
    sparse_observation: st.sparse_observation,
  };
}

function baseState(overrides: Partial<FrameState> = {}): FrameState {
  const st: FrameState = {
    frame: 10,
    timestamp_ms: 1000,
    missing: { ocr: false, objects: false },
    active_page: { id: "p1", name: "Page" },
    zone_summary: {
      z1: { name: "Z1", priority: 1, occupancy: 2, object_ids: ["a", "b"] },
    },
    object_primary_zone: {},
    ocr_boxes: [],
    ocr_by_label: {},
    objects: [],
    class_counts: { person: 2 },
    reconstruction_stats: {
      ocr: { observed: 0, carried: 0 },
      objects: { observed: 0, carried: 0, dropped_ttl: 0 },
    },
    sparse_observation: { ocr: false, objects: false },
    value_root: {},
    ...overrides,
  };
  st.value_root = buildValueRoot(st);
  return st;
}

describe("evalComparisonOp", () => {
  it("supports contains", () => {
    expect(evalComparisonOp("contains", "hello world", "world")).toBe(true);
    expect(evalComparisonOp("not_contains", "hello world", "world")).toBe(false);
  });
});

describe("evaluatePredicate", () => {
  it("evaluates logical and comparison on fields", () => {
    const st = baseState();
    const pred: PredicateNode = {
      kind: "logical",
      op: "and",
      children: [
        {
          kind: "comparison",
          left: { kind: "field", path: ["class_counts", "person"] },
          op: ">=",
          right: { kind: "literal", value: 2 },
        },
        { kind: "exists", path: ["zones", "z1"] },
      ],
    };
    const ctx = {
      evalFrame: st.frame,
      lastMatchFrame: null,
      stateAt: (f: number) => baseState({ frame: f }),
    };
    expect(evaluatePredicate(pred, st, st.frame, ctx)).toBe(true);
  });

  it("evaluates change vs prior frame", () => {
    const pred: PredicateNode = {
      kind: "change",
      path: ["class_counts", "person"],
      op: "increase",
      window_frames: 1,
    };
    const ctx = {
      evalFrame: 10,
      lastMatchFrame: null,
      stateAt: (f: number) =>
        baseState({
          frame: f,
          class_counts: f < 10 ? { person: 1 } : { person: 3 },
        }),
    };
    const st = baseState({ frame: 10, class_counts: { person: 3 } });
    expect(evaluatePredicate(pred, st, 10, ctx)).toBe(true);
  });
});
