import { z } from "zod";
import { eventDefinitionSchema } from "./events";
import { pageDefinitionSchema } from "./pages";
import { zoneDefinitionSchema } from "./zones";

export const videoMetadataSchema = z.object({
  video_id: z.string(),
  fps: z.number().positive(),
  frame_count: z.number().int().positive(),
  width: z.number().positive().int(),
  height: z.number().positive().int(),
  duration_seconds: z.number().nonnegative().optional(),
  /** Seconds into the source video file that frame 0 of this window corresponds to. */
  video_start_time_seconds: z.number().nonnegative().optional(),
});

export type VideoMetadata = z.infer<typeof videoMetadataSchema>;

export const parquetColumnMapSchema = z.object({
  frame: z.string(),
  timestamp_ms: z.string().optional(),
  /** OCR-specific */
  ocr_label: z.string().optional(),
  ocr_text: z.string().optional(),
  ocr_x: z.string().optional(),
  ocr_y: z.string().optional(),
  ocr_w: z.string().optional(),
  ocr_h: z.string().optional(),
  ocr_confidence: z.string().optional(),
  /** Object detection */
  object_id: z.string().optional(),
  object_class: z.string().optional(),
  object_score: z.string().optional(),
  bbox_x: z.string().optional(),
  bbox_y: z.string().optional(),
  bbox_w: z.string().optional(),
  bbox_h: z.string().optional(),
  page_hint: z.string().optional(),
});

export type ParquetColumnMap = z.infer<typeof parquetColumnMapSchema>;

export const ocrLabelPlacementSchema = z.object({
  label: z.string(),
  anchor: z.enum(["top_left", "center"]).default("top_left"),
  offset_x: z.number().default(0),
  offset_y: z.number().default(0),
});

/** Forward-fill: OCR carries last label values for ocr_ttl_frames; objects carry for object_ttl_frames. */
export const reconstructionConfigSchema = z.object({
  /** Frames to carry object tracks after last observation (default: 2 — objects sampled every other frame). */
  object_ttl_frames: z.number().int().min(0).default(2),
  /** Frames to forward-fill OCR labels after last observation (default: 5 — OCR sampled every 5th frame). */
  ocr_ttl_frames: z.number().int().min(0).default(5),
});

export const classificationConfigSchema = z.object({
  version: z.literal(1),
  video: videoMetadataSchema,
  parquet: z.object({
    ocr: parquetColumnMapSchema.optional(),
    objects: parquetColumnMapSchema.optional(),
  }),
  ocr_label_placements: z.array(ocrLabelPlacementSchema).default([]),
  /** Sparse timeline reconstruction (default applied when missing from JSON) */
  reconstruction: reconstructionConfigSchema.default({ object_ttl_frames: 2, ocr_ttl_frames: 5 }),
  zones: z.array(zoneDefinitionSchema).default([]),
  pages: z.array(pageDefinitionSchema).default([]),
  events: z.array(eventDefinitionSchema).default([]),
});

export type ClassificationConfig = z.infer<typeof classificationConfigSchema>;
