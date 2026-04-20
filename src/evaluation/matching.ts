import type { TimelineEvent } from "@/schemas/labels";

export type MatchPair = {
  manual: TimelineEvent;
  predicted: TimelineEvent;
  temporalErrorFrames: number;
};

function rangeIoU(a: [number, number], b: [number, number]): number {
  const s1 = a[0];
  const e1 = a[1];
  const s2 = b[0];
  const e2 = b[1];
  const inter = Math.max(0, Math.min(e1, e2) - Math.max(s1, s2) + 1);
  const len1 = e1 - s1 + 1;
  const len2 = e2 - s2 + 1;
  const union = len1 + len2 - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * Greedy one-to-one matching within tolerance. Point events match if |df|<=tolerance.
 * Range events match if IoU >= iouThreshold (default 0.2) and same name.
 */
export function matchEventsOneToOne(
  manual: TimelineEvent[],
  predicted: TimelineEvent[],
  opts: { tolerance: number; rangeIouThreshold?: number },
): { pairs: MatchPair[]; unmatchedManual: TimelineEvent[]; unmatchedPred: TimelineEvent[] } {
  const iouT = opts.rangeIouThreshold ?? 0.2;
  const pairs: MatchPair[] = [];
  const usedPred = new Set<string>();
  const unmatchedManual: TimelineEvent[] = [];
  const predsByName = new Map<string, TimelineEvent[]>();
  for (const p of predicted) {
    const arr = predsByName.get(p.event_name) ?? [];
    arr.push(p);
    predsByName.set(p.event_name, arr);
  }
  for (const [k, arr] of predsByName) {
    arr.sort((a, b) => a.start_frame - b.start_frame);
    predsByName.set(k, arr);
  }
  const manualSorted = [...manual].sort((a, b) => a.start_frame - b.start_frame);
  for (const m of manualSorted) {
    const pool = (predsByName.get(m.event_name) ?? []).filter((p) => !usedPred.has(p.id));
    let best: { p: TimelineEvent; err: number } | null = null;
    for (const p of pool) {
      if (m.kind === "point" && p.kind === "point") {
        const err = Math.abs(m.start_frame - p.start_frame);
        if (err <= opts.tolerance && (!best || err < best.err)) best = { p, err };
      } else if (m.kind === "range" && p.kind === "range") {
        const mf: [number, number] = [m.start_frame, m.end_frame ?? m.start_frame];
        const pf: [number, number] = [p.start_frame, p.end_frame ?? p.start_frame];
        const iou = rangeIoU(mf, pf);
        if (iou >= iouT) {
          const err = Math.abs(m.start_frame - p.start_frame);
          if (!best || err < best.err) best = { p, err };
        }
      }
    }
    if (best) {
      usedPred.add(best.p.id);
      pairs.push({
        manual: m,
        predicted: best.p,
        temporalErrorFrames: best.err,
      });
    } else {
      unmatchedManual.push(m);
    }
  }
  const unmatchedPred = predicted.filter((p) => !usedPred.has(p.id));
  return { pairs, unmatchedManual, unmatchedPred };
}
