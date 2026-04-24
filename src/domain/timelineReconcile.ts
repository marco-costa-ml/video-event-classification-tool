import type { ClassificationConfig } from "@/schemas";
import type { LoadedParquetSlice } from "./types";
import { maxFramesForWindow } from "./timelineWindow";

function maxFrameInSlice(slice: LoadedParquetSlice | null): number {
  if (!slice?.frames.length) return -1;
  let m = -Infinity;
  for (const f of slice.frames) if (f > m) m = f;
  return Number.isFinite(m) ? m : -1;
}

export type VideoIntrinsics = {
  durationSec: number;
  width: number;
  height: number;
};

/**
 * Keeps `frame_count` at least the max of: existing config, parquet max frame (+1), and video-derived length.
 * When intrinsics are provided, updates native width/height and duration.
 */
export function reconcileVideoTimeline(
  config: ClassificationConfig,
  slices: { ocr: LoadedParquetSlice | null; objects: LoadedParquetSlice | null },
  intrinsics?: VideoIntrinsics | null,
): ClassificationConfig {
  const maxIdx = Math.max(maxFrameInSlice(slices.ocr), maxFrameInSlice(slices.objects));
  const needFromParquet = maxIdx >= 0 ? maxIdx + 1 : 0;
  const fps = config.video.fps;
  const needFromVideo =
    intrinsics && Number.isFinite(intrinsics.durationSec) && intrinsics.durationSec > 0 && fps > 0
      ? Math.max(1, Math.ceil(intrinsics.durationSec * fps))
      : 0;
  const unclamped = Math.max(config.video.frame_count, needFromParquet, needFromVideo, 1);
  const capFrames = maxFramesForWindow(fps);
  const frame_count = Math.max(1, Math.min(unclamped, capFrames));

  let width = config.video.width;
  let height = config.video.height;
  if (intrinsics && intrinsics.width > 0 && intrinsics.height > 0) {
    width = Math.round(intrinsics.width);
    height = Math.round(intrinsics.height);
  }

  return {
    ...config,
    video: {
      ...config.video,
      frame_count,
      width,
      height,
      duration_seconds: intrinsics?.durationSec ?? config.video.duration_seconds,
    },
  };
}
