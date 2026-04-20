import { z } from "zod";

const pointSchema = z.object({ x: z.number(), y: z.number() });

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
  metadata: z.record(z.unknown()).optional(),
});

export type ZoneDefinition = z.infer<typeof zoneDefinitionSchema>;
