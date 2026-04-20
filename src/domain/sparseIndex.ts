import type { LoadedParquetSlice } from "./types";

/** Frame -> inclusive [start,end) row index range in slice.rows (sorted by frame) */
export type FrameRowRangeIndex = {
  frameToStart: Map<number, number>;
};

function buildFrameIndex(slice: LoadedParquetSlice): FrameRowRangeIndex {
  const frameToStart = new Map<number, number>();
  for (let i = 0; i < slice.rows.length; i++) {
    const f = slice.frames[i]!;
    if (!frameToStart.has(f)) frameToStart.set(f, i);
  }
  return { frameToStart };
}

export type SparseIndex = {
  ocr: FrameRowRangeIndex | null;
  objects: FrameRowRangeIndex | null;
};

export function buildSparseIndex(bundle: {
  ocr: LoadedParquetSlice | null;
  objects: LoadedParquetSlice | null;
}): SparseIndex {
  return {
    ocr: bundle.ocr ? buildFrameIndex(bundle.ocr) : null,
    objects: bundle.objects ? buildFrameIndex(bundle.objects) : null,
  };
}

export function rowRangeForFrame(
  idx: FrameRowRangeIndex | null,
  slice: LoadedParquetSlice | null,
  frame: number,
): { start: number; end: number } {
  if (!idx || !slice || slice.rows.length === 0) return { start: 0, end: 0 };
  const start = idx.frameToStart.get(frame);
  if (start === undefined) return { start: 0, end: 0 };
  let end = start;
  while (end < slice.rows.length && slice.frames[end] === frame) end++;
  return { start, end };
}

const DEFAULT_WINDOW = 32;

export type FrameWindow = { start: number; end: number };

/** Inclusive frame window [center-half, center+half] clipped to [0, maxFrame] */
export function neighborWindow(center: number, maxFrame: number, half: number = DEFAULT_WINDOW): FrameWindow {
  const s = Math.max(0, center - half);
  const e = Math.min(maxFrame, center + half);
  return { start: s, end: e };
}
