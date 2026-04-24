import type { ClassificationConfig, EventDefinition } from "@/schemas";
import type { TimelineEvent } from "@/schemas/labels";
import { evaluatePredicate, type EvalContext } from "./predicateEval";
import type { FrameStateCache } from "./frameReconstruction";
import { collapsePredictedEvents } from "./eventDedupe";

export type FiredEvent = {
  eventId: string;
  eventName: string;
  frame: number;
  priority: number;
};

export function evaluateEventsAtFrame(
  events: EventDefinition[],
  cache: FrameStateCache,
  frame: number,
  lastMatchByEvent: Record<string, number | null>,
): FiredEvent[] {
  const sorted = [...events].sort((a, b) => b.priority - a.priority);
  const st = cache.get(frame);
  const stateAt = (f: number) => cache.get(f);
  const fired: FiredEvent[] = [];
  for (const ev of sorted) {
    const last = lastMatchByEvent[ev.id] ?? null;
    if (ev.cooldown_frames && last !== null && frame - last < ev.cooldown_frames) {
      continue;
    }
    const ctx: EvalContext = { evalFrame: frame, lastMatchFrame: last, stateAt };
    if (evaluatePredicate(ev.predicate, st, frame, ctx)) {
      fired.push({ eventId: ev.id, eventName: ev.name, frame, priority: ev.priority });
    }
  }
  return fired;
}

export function runEventDetection(
  config: ClassificationConfig,
  cache: FrameStateCache,
  maxFrame: number,
): { firedByFrame: Map<number, FiredEvent[]>; timeline: TimelineEvent[] } {
  if (!config.events.length) {
    return { firedByFrame: new Map(), timeline: [] };
  }
  const firedByFrame = new Map<number, FiredEvent[]>();
  const lastMatch: Record<string, number | null> = {};
  const rawPoints: TimelineEvent[] = [];
  for (let f = 0; f <= maxFrame; f++) {
    const fired = evaluateEventsAtFrame(config.events, cache, f, lastMatch);
    if (fired.length) firedByFrame.set(f, fired);
    for (const e of fired) {
      lastMatch[e.eventId] = f;
      rawPoints.push({
        id: `pred_${e.eventId}_${f}_${rawPoints.length}`,
        kind: "point",
        event_name: e.eventName,
        start_frame: f,
        end_frame: f,
        source: "predicted",
      });
    }
  }
  const timeline = collapsePredictedEvents(rawPoints, config.events);
  return { firedByFrame, timeline };
}
