import { describe, expect, it } from "vitest";
import type { LoadedParquetSlice, OcrBox, ObjectBox } from "@/domain/types";
import {
  buildForwardReconstruction,
  queryObjectsAtFrameCached,
  queryOcrAtFrameCached,
} from "@/domain/forwardReconstruction";

function ocrSlice(frames: number[], perFrame: OcrBox[][]): LoadedParquetSlice {
  return { role: "ocr", frames, rows: perFrame };
}

function objSlice(frames: number[], perFrame: ObjectBox[][]): LoadedParquetSlice {
  return { role: "objects", frames, rows: perFrame };
}

const b = (text: string, _f: number, label = "L"): OcrBox => ({
  label,
  text,
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  confidence: 1,
});

const ob = (id: string, _f: number): ObjectBox => ({
  id,
  className: "x",
  score: 1,
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  metadata: {},
});

describe("queryOcrAtFrame", () => {
  it("carries the latest label value forward", () => {
    const s = ocrSlice(
      [0, 5],
      [[b("a", 0)], [b("b", 5)]],
    );
    const fwd = buildForwardReconstruction(s, null, 100, 30, 20);
    const q0 = queryOcrAtFrameCached(fwd, 0);
    const q2 = queryOcrAtFrameCached(fwd, 2);
    const q5 = queryOcrAtFrameCached(fwd, 5);
    expect(q0.ocr_by_label["L"]?.[0]?.text).toBe("a");
    expect(q0.stats.carried + q0.stats.observed).toBe(1);
    expect(q0.stats.carried).toBe(0);
    expect(q2.ocr_by_label["L"]?.[0]?.text).toBe("a");
    expect(q2.ocr_by_label["L"]?.[0]?.provenance).toBe("carried");
    expect(q5.ocr_by_label["L"]?.[0]?.text).toBe("b");
    expect(q5.ocr_by_label["L"]?.[0]?.provenance).toBe("observed");
  });
});

describe("queryObjectsAtFrame", () => {
  it("applies TTL from last explicit observation", () => {
    const s = objSlice(
      [0, 10],
      [[ob("o1", 0)], [ob("o1", 10)]],
    );
    const fwd = buildForwardReconstruction(null, s, 100, 5, 20);
    const at4 = queryObjectsAtFrameCached(fwd, 4);
    const at5 = queryObjectsAtFrameCached(fwd, 5);
    const at6 = queryObjectsAtFrameCached(fwd, 6);
    expect(at4.objects.map((o) => o.id)).toEqual(["o1"]);
    expect(at4.objects[0]!.provenance).toBe("carried");
    expect(at5.objects.map((o) => o.id)).toEqual(["o1"]);
    expect(at5.objects[0]!.provenance).toBe("carried");
    expect(at6.objects).toEqual([]);
  });
});
