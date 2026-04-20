import type { TimelineEvent } from "@/schemas/labels";
import { matchEventsOneToOne, type MatchPair } from "./matching";

export type EventTypeMetrics = {
  event_name: string;
  manual_count: number;
  predicted_count: number;
  count_abs_diff: number;
  matched: number;
  false_positives: number;
  false_negatives: number;
  precision: number;
  recall: number;
  f1: number;
  avg_temporal_error_frames: number | null;
  median_temporal_error_frames: number | null;
};

export type EvaluationReport = {
  per_type: EventTypeMetrics[];
  overall: {
    manual_count: number;
    predicted_count: number;
    matched: number;
    false_positives: number;
    false_negatives: number;
    precision: number;
    recall: number;
    f1: number;
  };
  pairs: MatchPair[];
};

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2) return s[mid]!;
  return (s[mid - 1]! + s[mid]!) / 2;
}

export function evaluateTimeline(
  manual: TimelineEvent[],
  predicted: TimelineEvent[],
  tolerance: number,
): EvaluationReport {
  const names = new Set<string>();
  for (const e of manual) names.add(e.event_name);
  for (const e of predicted) names.add(e.event_name);
  const per_type: EventTypeMetrics[] = [];
  const allPairs: MatchPair[] = [];
  let manualTotal = 0;
  let predTotal = 0;
  let matchedTotal = 0;
  let fpTotal = 0;
  let fnTotal = 0;
  for (const name of [...names].sort()) {
    const msub = manual.filter((e) => e.event_name === name);
    const psub = predicted.filter((e) => e.event_name === name);
    const { pairs, unmatchedManual, unmatchedPred } = matchEventsOneToOne(msub, psub, { tolerance });
    allPairs.push(...pairs);
    const mc = msub.length;
    const pc = psub.length;
    const mat = pairs.length;
    const fn = unmatchedManual.length;
    const fp = unmatchedPred.length;
    const precision = pc === 0 ? (mat === 0 ? 1 : 0) : mat / pc;
    const recall = mc === 0 ? (mat === 0 ? 1 : 0) : mat / mc;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    const errs = pairs.map((p) => p.temporalErrorFrames);
    per_type.push({
      event_name: name,
      manual_count: mc,
      predicted_count: pc,
      count_abs_diff: Math.abs(mc - pc),
      matched: mat,
      false_positives: fp,
      false_negatives: fn,
      precision,
      recall,
      f1,
      avg_temporal_error_frames: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null,
      median_temporal_error_frames: median(errs),
    });
    manualTotal += mc;
    predTotal += pc;
    matchedTotal += mat;
    fpTotal += fp;
    fnTotal += fn;
  }
  const precision = predTotal === 0 ? (matchedTotal === 0 ? 1 : 0) : matchedTotal / predTotal;
  const recall = manualTotal === 0 ? (matchedTotal === 0 ? 1 : 0) : matchedTotal / manualTotal;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    per_type,
    overall: {
      manual_count: manualTotal,
      predicted_count: predTotal,
      matched: matchedTotal,
      false_positives: fpTotal,
      false_negatives: fnTotal,
      precision,
      recall,
      f1,
    },
    pairs: allPairs,
  };
}
