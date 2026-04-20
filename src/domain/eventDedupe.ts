import type { EventDefinition } from "@/schemas";
import type { TimelineEvent } from "@/schemas/labels";

function mergeWindowForName(evName: string, defs: EventDefinition[]): number {
  const def = defs.find((d) => d.name === evName) ?? defs.find((d) => d.id === evName);
  return def?.dedupe?.merge_adjacent_frames ?? 1;
}

/**
 * Merges adjacent predicted point events of the same name within merge window into single point (leading edge).
 */
export function collapsePredictedEvents(events: TimelineEvent[], defs: EventDefinition[]): TimelineEvent[] {
  const sorted = [...events].sort((a, b) => a.start_frame - b.start_frame);
  const out: TimelineEvent[] = [];
  for (const ev of sorted) {
    if (ev.kind !== "point") {
      out.push(ev);
      continue;
    }
    const window = mergeWindowForName(ev.event_name, defs);
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === "point" &&
      prev.event_name === ev.event_name &&
      ev.start_frame - prev.start_frame <= window
    ) {
      continue;
    }
    out.push({ ...ev, id: ev.id });
  }
  return out;
}

/** Collapse by fixed frame window regardless of config (used before evaluation). */
export function collapseAdjacentByName(events: TimelineEvent[], window: number): TimelineEvent[] {
  const sorted = [...events].sort((a, b) => a.start_frame - b.start_frame);
  const out: TimelineEvent[] = [];
  for (const ev of sorted) {
    if (ev.kind !== "point") {
      out.push(ev);
      continue;
    }
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === "point" &&
      prev.event_name === ev.event_name &&
      ev.start_frame - prev.start_frame <= window
    ) {
      continue;
    }
    out.push(ev);
  }
  return out;
}
