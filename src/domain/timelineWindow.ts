import type { LoadedParquetSlice } from "./types";

export const MAX_UPLOAD_WINDOW_SECONDS = 20 * 60;

export function maxFramesForWindow(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 1;
  return Math.max(1, Math.floor(MAX_UPLOAD_WINDOW_SECONDS * fps));
}

export function clipSliceToMaxFrame(
  slice: LoadedParquetSlice | null,
  maxFrameInclusive: number,
): LoadedParquetSlice | null {
  if (!slice) return null;
  if (!slice.frames.length) return slice;
  const frames: number[] = [];
  const rows: unknown[][] = [];
  for (let i = 0; i < slice.frames.length; i++) {
    const f = slice.frames[i]!;
    if (f > maxFrameInclusive) break;
    frames.push(f);
    rows.push(slice.rows[i]!);
  }
  if (frames.length === slice.frames.length) return slice;
  return {
    role: slice.role,
    frames,
    rows,
  };
}
