import { z } from "zod";
import { fieldPathSchema } from "./fieldPath";

export const comparisonOpSchema = z.enum([
  "==",
  "!=",
  ">",
  "<",
  ">=",
  "<=",
  "contains",
  "not_contains",
  "in",
  "not_in",
]);

export const changeOpSchema = z.enum([
  "changed",
  "unchanged",
  "increase",
  "decrease",
  "delta_gt",
  "delta_lt",
]);

export const transitionKindSchema = z.enum([
  "page",
  "zone",
  "value",
  "object_zone",
]);

export const aggregateOpSchema = z.enum(["sum", "min", "max", "count", "any", "all"]);

const literalValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number()])),
]);

export const valueExprSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("literal"),
      value: literalValueSchema,
    }),
    z.object({
      kind: z.literal("field"),
      path: fieldPathSchema,
    }),
    z.object({
      kind: z.literal("window_field"),
      path: fieldPathSchema,
      offset_frames: z.number().int(),
    }),
  ]),
);

export type ValueExpr = z.infer<typeof valueExprSchema>;

export const predicateNodeSchema = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal("logical"),
      op: z.enum(["and", "or", "not"]),
      children: z.array(predicateNodeSchema),
    }),
    z.object({
      kind: z.literal("comparison"),
      left: valueExprSchema,
      op: comparisonOpSchema,
      right: valueExprSchema,
    }),
    z.object({
      kind: z.literal("exists"),
      path: fieldPathSchema,
    }),
    z.object({
      kind: z.literal("not_exists"),
      path: fieldPathSchema,
    }),
    z.object({
      kind: z.literal("change"),
      path: fieldPathSchema,
      op: changeOpSchema,
      threshold: z.number().optional(),
      window_frames: z.number().int().min(1).default(1),
    }),
    z.object({
      kind: z.literal("transition"),
      transition: transitionKindSchema,
      from: valueExprSchema.optional(),
      to: valueExprSchema.optional(),
      object_id_field: fieldPathSchema.optional(),
      zone_from: z.string().optional(),
      zone_to: z.string().optional(),
      window_frames: z.number().int().min(1).default(1),
    }),
    z.object({
      kind: z.literal("aggregate"),
      op: aggregateOpSchema,
      path: fieldPathSchema,
      filter: predicateNodeSchema.optional(),
      compare: z
        .object({
          op: comparisonOpSchema,
          right: valueExprSchema,
        })
        .optional(),
    }),
    z.object({
      kind: z.literal("temporal"),
      anchor: z.enum(["eval_frame", "last_match"]),
      offset_frames: z.number().int(),
      window_before: z.number().int().min(0).default(0),
      window_after: z.number().int().min(0).default(0),
      child: predicateNodeSchema,
    }),
  ]),
);

export type PredicateNode = z.infer<typeof predicateNodeSchema>;
