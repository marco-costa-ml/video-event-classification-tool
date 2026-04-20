import { z } from "zod";

/** Shared schema for manual ground truth and predicted / exported events */
export const timelineEventKindSchema = z.enum(["point", "range"]);

export const timelineEventSchema = z.object({
  id: z.string(),
  kind: timelineEventKindSchema,
  event_name: z.string(),
  /** Inclusive frame index for point events (start == end) */
  start_frame: z.number().int(),
  end_frame: z.number().int().optional(),
  source: z.enum(["manual", "predicted", "imported"]).default("manual"),
  confidence: z.number().min(0).max(1).optional(),
  notes: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type TimelineEvent = z.infer<typeof timelineEventSchema>;

export const groundTruthExportSchema = z.object({
  version: z.literal(1),
  video_id: z.string().optional(),
  events: z.array(timelineEventSchema),
});

export type GroundTruthExport = z.infer<typeof groundTruthExportSchema>;
