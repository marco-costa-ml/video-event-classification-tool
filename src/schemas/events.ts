import { z } from "zod";
import { predicateNodeSchema } from "./predicates";

export const eventDedupeSchema = z.object({
  merge_adjacent_frames: z.number().int().min(0).default(2),
  strategy: z.enum(["leading_edge", "merge_ranges"]).default("leading_edge"),
});

export const eventDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  priority: z.number().int(),
  predicate: predicateNodeSchema,
  cooldown_frames: z.number().int().min(0).optional(),
  dedupe: eventDedupeSchema.optional(),
  export_tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type EventDefinition = z.infer<typeof eventDefinitionSchema>;
