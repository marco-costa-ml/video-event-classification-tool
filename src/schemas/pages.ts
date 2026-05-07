import { z } from "zod";
import { predicateNodeSchema } from "./predicates";

export const pageDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  priority: z.number().int(),
  match: predicateNodeSchema,
  /** Zone ids to include in enriched export when this page is active. Missing => include all. */
  export_include_zone_ids: z.array(z.string()).optional(),
  /** OCR labels to include in enriched export when this page is active. Missing => include all. */
  export_include_ocr_labels: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type PageDefinition = z.infer<typeof pageDefinitionSchema>;
