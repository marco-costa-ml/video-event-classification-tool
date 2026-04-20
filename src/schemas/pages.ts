import { z } from "zod";
import { predicateNodeSchema } from "./predicates";

export const pageDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  priority: z.number().int(),
  match: predicateNodeSchema,
  metadata: z.record(z.unknown()).optional(),
});

export type PageDefinition = z.infer<typeof pageDefinitionSchema>;
