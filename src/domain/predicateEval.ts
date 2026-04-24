import type { PredicateNode, ValueExpr } from "@/schemas";
import type { FieldPath } from "@/schemas/fieldPath";
import type { FrameState } from "./types";

export type EvalContext = {
  evalFrame: number;
  lastMatchFrame: number | null;
  /** Resolve state at arbitrary frame (must be provided by caller) */
  stateAt: (frame: number) => FrameState;
};

function getAtPath(root: unknown, path: FieldPath): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[seg as string | number];
  }
  return cur;
}

function evalValue(expr: ValueExpr, st: FrameState, ctx: EvalContext): unknown {
  if (expr.kind === "literal") return expr.value;
  if (expr.kind === "field") return getAtPath(st.value_root, expr.path);
  const f = ctx.evalFrame + expr.offset_frames;
  const other = ctx.stateAt(f);
  return getAtPath(other.value_root, expr.path);
}

export function evalComparisonOp(
  cop: Extract<PredicateNode, { kind: "comparison" }>["op"],
  left: unknown,
  right: unknown,
): boolean {
  if (cop === "==") return left === right;
  if (cop === "!=") return left !== right;
  if (cop === ">" || cop === "<" || cop === ">=" || cop === "<=") {
    const ln = typeof left === "number" ? left : Number(left);
    const rn = typeof right === "number" ? right : Number(right);
    if (!Number.isFinite(ln) || !Number.isFinite(rn)) return false;
    if (cop === ">") return ln > rn;
    if (cop === "<") return ln < rn;
    if (cop === ">=") return ln >= rn;
    if (cop === "<=") return ln <= rn;
  }
  const ls = left === null || left === undefined ? "" : String(left);
  const rs = right === null || right === undefined ? "" : String(right);
  if (cop === "contains") return ls.includes(rs);
  if (cop === "not_contains") return !ls.includes(rs);
  if (cop === "in") {
    if (!Array.isArray(right)) return false;
    return right.some((v) => v === left);
  }
  if (cop === "not_in") {
    if (!Array.isArray(right)) return true;
    return !right.some((v) => v === left);
  }
  return false;
}

function numericValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function evaluatePredicate(node: PredicateNode, st: FrameState, frame: number, ctx: EvalContext): boolean {
  const stateAt = ctx.stateAt;
  const baseCtx: EvalContext = { ...ctx, evalFrame: frame, stateAt };

  switch (node.kind) {
    case "logical": {
      if (node.op === "not") {
        const ch = node.children[0];
        return ch ? !evaluatePredicate(ch, st, frame, baseCtx) : true;
      }
      if (node.op === "and")
        return node.children.every((c: PredicateNode) => evaluatePredicate(c, st, frame, baseCtx));
      return node.children.some((c: PredicateNode) => evaluatePredicate(c, st, frame, baseCtx));
    }
    case "comparison": {
      const l = evalValue(node.left, st, baseCtx);
      const r = evalValue(node.right, st, baseCtx);
      return evalComparisonOp(node.op, l, r);
    }
    case "exists": {
      const v = getAtPath(st.value_root, node.path);
      return v !== undefined && v !== null;
    }
    case "not_exists": {
      const v = getAtPath(st.value_root, node.path);
      return v === undefined || v === null;
    }
    case "change": {
      const cur = getAtPath(st.value_root, node.path);
      const prevFrame = frame - node.window_frames;
      const prev = stateAt(prevFrame);
      const prevVal = getAtPath(prev.value_root, node.path);
      const cn = numericValue(cur);
      const pn = numericValue(prevVal);
      switch (node.op) {
        case "changed":
          return JSON.stringify(cur) !== JSON.stringify(prevVal);
        case "unchanged":
          return JSON.stringify(cur) === JSON.stringify(prevVal);
        case "increase":
          return cn !== null && pn !== null && cn > pn;
        case "decrease":
          return cn !== null && pn !== null && cn < pn;
        case "delta_gt": {
          const th = node.threshold ?? 0;
          return cn !== null && pn !== null && cn - pn > th;
        }
        case "delta_lt": {
          const th = node.threshold ?? 0;
          return cn !== null && pn !== null && cn - pn < th;
        }
        default:
          return false;
      }
    }
    case "transition": {
      if (node.transition === "page") {
        const prevSt = stateAt(frame - node.window_frames);
        const prevId = prevSt.active_page?.id ?? "";
        const curId = st.active_page?.id ?? "";
        if (prevId === curId) return false;
        if (node.from) {
          const fv = evalValue(node.from, prevSt, { ...baseCtx, evalFrame: frame - node.window_frames });
          if (node.from.kind === "literal") {
            if (String(fv) !== String(node.from.value)) return false;
          } else if (String(fv) !== prevId) return false;
        }
        if (node.to) {
          const tv = evalValue(node.to, st, baseCtx);
          if (node.to.kind === "literal") {
            if (String(tv) !== String(node.to.value)) return false;
          } else if (String(tv) !== curId) return false;
        }
        return true;
      }
      if (node.transition === "object_zone" && node.zone_from && node.zone_to) {
        /** Any object moved from zone_from to zone_to between frames */
        const prev = stateAt(frame - node.window_frames);
        const moved = st.objects.some((o) => {
          const zNow = st.object_primary_zone[o.id]?.zoneId ?? "";
          const zPrev = prev.object_primary_zone[o.id]?.zoneId ?? "";
          return zPrev === node.zone_from && zNow === node.zone_to;
        });
        return moved;
      }
      return false;
    }
    case "aggregate": {
      /** Minimal: path points to array or object values; count elements matching filter */
      const base = getAtPath(st.value_root, node.path);
      if (node.op === "count") {
        let n = 0;
        if (Array.isArray(base)) {
          n = base.length;
        } else if (base && typeof base === "object") {
          n = Object.keys(base as object).length;
        }
        if (!node.compare) return n > 0;
        return evalComparisonOp(node.compare.op, n, evalValue(node.compare.right, st, baseCtx));
      }
      if (node.op === "sum" && Array.isArray(base)) {
        const s = base.reduce((a: number, v) => a + (numericValue(v) ?? 0), 0);
        if (!node.compare) return s !== 0;
        return evalComparisonOp(node.compare.op, s, evalValue(node.compare.right, st, baseCtx));
      }
      return false;
    }
    case "temporal": {
      const anchor =
        node.anchor === "last_match" && ctx.lastMatchFrame !== null ? ctx.lastMatchFrame : frame;
      const target = anchor + node.offset_frames;
      const windowSt = stateAt(target);
      return evaluatePredicate(node.child, windowSt, target, { ...baseCtx, evalFrame: target });
    }
    default:
      return false;
  }
}
