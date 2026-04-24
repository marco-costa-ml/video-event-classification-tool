import { z } from "zod";

const pointSchema = z.object({ x: z.number(), y: z.number() });

/** Inclusive integer class-id range (numeric `ObjectBox.className`). */
export const objectClassRangeSchema = z
  .object({
    min: z.number().int(),
    max: z.number().int(),
  })
  .transform((r) => ({ min: Math.min(r.min, r.max), max: Math.max(r.min, r.max) }));

export type ObjectClassRange = z.infer<typeof objectClassRangeSchema>;

export const zoneGeometrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rectangle"),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
  z.object({
    type: z.literal("polygon"),
    points: z.array(pointSchema).min(3),
  }),
]);

export const zoneDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  priority: z.number().int(),
  geometry: zoneGeometrySchema,
  parent_classes: z.array(z.string()).default([]),
  object_classes: z.array(z.string()).default([]),
  /** If non-empty, numeric class ids in these inclusive ranges may occupy the zone (OR with exact lists below). */
  object_class_ranges: z.array(objectClassRangeSchema).default([]),
  metadata: z.record(z.unknown()).optional(),
});

export type ZoneDefinition = z.infer<typeof zoneDefinitionSchema>;
