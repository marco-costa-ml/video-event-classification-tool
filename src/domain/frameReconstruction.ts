import type { ClassificationConfig, PageDefinition, ZoneDefinition } from "@/schemas";
import type { FrameState, LoadedParquetSlice, ObjectBox } from "./types";
import { allCornersInZone } from "./geometry";
import { evaluatePredicate, type EvalContext } from "./predicateEval";
import {
  buildForwardReconstruction,
  queryObjectsAtFrameCached,
  queryOcrAtFrameCached,
  type ForwardReconstruction,
} from "./forwardReconstruction";

/** Integer class id from parquet `class` when stored as a numeric string. */
function numericObjectClassId(className: string): number | null {
  const t = className.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

/**
 * Whether an object may contribute to zone occupancy / primary zone assignment.
 * - If `object_class_ranges` is non-empty and both exact lists are empty: only numeric classes in any range match.
 * - If ranges are empty: same as before (object_classes / parent_classes OR semantics with empty = allow).
 * - If ranges and exact lists are both used: match if in any range OR on either exact list.
 */
function classMatchesZoneEligibility(z: ZoneDefinition, o: ObjectBox): boolean {
  const ranges = z.object_class_ranges ?? [];
  const hasRanges = ranges.length > 0;
  const n = numericObjectClassId(o.className);
  const inAnyRange = n !== null && ranges.some((r) => n >= r.min && n <= r.max);

  const clsOk = z.object_classes.length === 0 || z.object_classes.includes(o.className);
  const parentOk = z.parent_classes.length === 0 || z.parent_classes.includes(o.className);
  const exactOk = clsOk || parentOk;

  if (hasRanges && z.object_classes.length === 0 && z.parent_classes.length === 0) {
    return inAnyRange;
  }
  if (!hasRanges) {
    return exactOk;
  }
  return inAnyRange || exactOk;
}

function assignObjectsToZones(
  objects: ObjectBox[],
  zones: ZoneDefinition[],
): {
  zone_summary: FrameState["zone_summary"];
  zone_membership_summary: FrameState["zone_membership_summary"];
  object_primary_zone: FrameState["object_primary_zone"];
} {
  const sortedZones = [...zones].sort((a, b) => b.priority - a.priority);
  const object_primary_zone: FrameState["object_primary_zone"] = {};
  const zoneBuckets: Record<string, string[]> = {};
  const membershipBuckets: Record<string, string[]> = {};
  for (const z of sortedZones) {
    zoneBuckets[z.id] = [];
    membershipBuckets[z.id] = [];
  }
  for (const o of objects) {
    let chosen: ZoneDefinition | null = null;
    for (const z of sortedZones) {
      if (!classMatchesZoneEligibility(z, o)) continue;
      if (allCornersInZone(o, z)) {
        membershipBuckets[z.id]!.push(o.id);
        if (!chosen) chosen = z;
      }
    }
    if (chosen) {
      object_primary_zone[o.id] = {
        zoneId: chosen.id,
        zoneName: chosen.name,
        priority: chosen.priority,
      };
      zoneBuckets[chosen.id]!.push(o.id);
    } else {
      object_primary_zone[o.id] = null;
    }
  }
  const zone_summary: FrameState["zone_summary"] = {};
  const zone_membership_summary: FrameState["zone_membership_summary"] = {};
  for (const z of sortedZones) {
    const ids = zoneBuckets[z.id] ?? [];
    zone_summary[z.id] = {
      name: z.name,
      priority: z.priority,
      occupancy: ids.length,
      object_ids: ids,
    };
    const membershipIds = membershipBuckets[z.id] ?? [];
    zone_membership_summary[z.id] = {
      name: z.name,
      priority: z.priority,
      occupancy: membershipIds.length,
      object_ids: membershipIds,
    };
  }
  return { zone_summary, zone_membership_summary, object_primary_zone };
}

function rightmostLte(frames: readonly number[], f: number): number {
  if (!frames.length) return -1;
  let lo = 0;
  let hi = frames.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]! <= f) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function buildValueRoot(st: FrameState, extras: Record<string, unknown>) {
  st.value_root = {
    frame: st.frame,
    timestamp_ms: st.timestamp_ms,
    page: st.active_page,
    zones: st.zone_summary,
    zone_membership: st.zone_membership_summary,
    object_primary_zone: st.object_primary_zone,
    ocr: {
      by_label: st.ocr_by_label,
      boxes: st.ocr_boxes,
    },
    objects: st.objects,
    class_counts: st.class_counts,
    reconstruction: st.reconstruction_stats,
    ...extras,
  };
}

function objectTtl(config: ClassificationConfig): number {
  return config.reconstruction?.object_ttl_frames ?? 2;
}

function ocrTtl(config: ClassificationConfig): number {
  return config.reconstruction?.ocr_ttl_frames ?? 5;
}

export function reconstructFrameState(
  frame: number,
  config: ClassificationConfig,
  ocrSlice: LoadedParquetSlice | null,
  objSlice: LoadedParquetSlice | null,
  activePageOverride: { id: string; name: string } | null,
  forward: ForwardReconstruction,
): FrameState {
  const oq = queryOcrAtFrameCached(forward, frame);
  const oBox = queryObjectsAtFrameCached(forward, frame);
  const ocr_boxes = oq.ocr_boxes;
  const ocr_by_label = oq.ocr_by_label;
  const objects = oBox.objects;
  const class_counts: Record<string, number> = {};
  for (const o of objects) {
    class_counts[o.className] = (class_counts[o.className] ?? 0) + 1;
  }
  const { zone_summary, zone_membership_summary, object_primary_zone } = assignObjectsToZones(objects, config.zones);
  const timestamp_ms = (frame / config.video.fps) * 1000;
  const oI = ocrSlice ? rightmostLte(ocrSlice.frames, frame) : -1;
  const pI = objSlice ? rightmostLte(objSlice.frames, frame) : -1;
  const ocrOnSparse = Boolean(ocrSlice && oI >= 0 && ocrSlice.frames[oI] === frame);
  const objOnSparse = Boolean(objSlice && pI >= 0 && objSlice.frames[pI] === frame);
  const st: FrameState = {
    frame,
    timestamp_ms,
    missing: {
      ocr: !ocrSlice,
      objects: !objSlice,
    },
    active_page: activePageOverride,
    zone_summary,
    zone_membership_summary,
    object_primary_zone,
    ocr_boxes,
    ocr_by_label,
    objects,
    class_counts,
    reconstruction_stats: {
      ocr: { observed: oq.stats.observed, carried: oq.stats.carried },
      objects: {
        observed: oBox.stats.observed,
        carried: oBox.stats.carried,
        dropped_ttl: oBox.stats.dropped_ttl,
      },
    },
    sparse_observation: { ocr: ocrOnSparse, objects: objOnSparse },
    value_root: {},
  };
  buildValueRoot(st, {
    ocr_at_sparse_frame: ocrOnSparse,
    objects_at_sparse_frame: objOnSparse,
    ocr_label_provenance: oq.labelProvenance,
    sparse_observation: st.sparse_observation,
  });
  return st;
}

export function resolveActivePage(
  pages: PageDefinition[],
  st: FrameState,
  frame: number,
  stateAt: (frame: number) => FrameState,
): { id: string; name: string } | null {
  const ctx: EvalContext = { evalFrame: frame, lastMatchFrame: null, stateAt };
  const candidates: { id: string; name: string; priority: number }[] = [];
  for (const p of pages) {
    if (evaluatePredicate(p.match, st, frame, ctx)) {
      candidates.push({ id: p.id, name: p.name, priority: p.priority });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.priority - a.priority);
  return { id: candidates[0]!.id, name: candidates[0]!.name };
}

export type FrameStateCache = {
  get(frame: number): FrameState;
  prefetch(center: number, half: number): void;
  clear(): void;
};

export function createFrameStateCache(
  config: ClassificationConfig,
  ocrSlice: LoadedParquetSlice | null,
  objSlice: LoadedParquetSlice | null,
  maxFrame: number,
): FrameStateCache {
  const forward = buildForwardReconstruction(ocrSlice, objSlice, ocrTtl(config), objectTtl(config), maxFrame);
  const map = new Map<number, FrameState>();
  const baseMap = new Map<number, FrameState>();
  const maxEntries = 512;

  const clampFrame = (frame: number) => Math.max(0, Math.min(maxFrame, frame));

  const evictOldest = (m: Map<number, FrameState>) => {
    if (m.size <= maxEntries) return;
    const first = m.keys().next().value;
    if (first !== undefined) m.delete(first);
  };

  const baseAt = (frame: number): FrameState => {
    const f = clampFrame(frame);
    if (baseMap.has(f)) return baseMap.get(f)!;
    const st = reconstructFrameState(f, config, ocrSlice, objSlice, null, forward);
    baseMap.set(f, st);
    evictOldest(baseMap);
    return st;
  };

  const materialize = (fr: number): FrameState => {
    const f = clampFrame(fr);
    const base = baseAt(f);
    const page = resolveActivePage(config.pages, base, f, baseAt);
    const st: FrameState = {
      ...base,
      active_page: page,
      value_root: {
        ...base.value_root,
        page,
      },
    };
    return st;
  };

  return {
    get(frame: number) {
      const f = clampFrame(frame);
      if (map.has(f)) return map.get(f)!;
      const st = materialize(f);
      map.set(f, st);
      evictOldest(map);
      return st;
    },
    prefetch(center: number, half: number) {
      for (let x = center - half; x <= center + half; x++) {
        if (x < 0 || x > maxFrame) continue;
        if (!map.has(x)) map.set(x, materialize(x));
        evictOldest(map);
      }
    },
    clear() {
      map.clear();
      baseMap.clear();
    },
  };
}
