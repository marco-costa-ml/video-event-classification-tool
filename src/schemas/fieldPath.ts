import { z } from "zod";

/** Dot-path segments for OCR, objects, zones, derived values */
export const fieldPathSegmentSchema = z.union([
  z.string(),
  z.number().int(),
]);

export const fieldPathSchema = z.array(fieldPathSegmentSchema);

export type FieldPath = z.infer<typeof fieldPathSchema>;
