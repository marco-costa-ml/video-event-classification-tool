import type { ClassificationConfig, PageDefinition, ZoneDefinition } from "@/schemas";
import type { FrameState, LoadedParquetSlice, ObjectBox, OcrBox, ZoneHitInfo } from "./types";
import { objectCenter, pointInZone } from "./geometry";
import { rowRangeForFrame, type SparseIndex } from "./sparseIndex";
import { evaluatePredicate, type EvalContext } from "./predicateEval";

function flattenFrameRows<T>(slice: LoadedParquetSlice | null, start: number, end: number): T[] {
  if (!slice) return [];
  const out: T[] = [];
  for (let i = start; i < end; i++) {
    const chunk = slice.rows[i] as T[];
    for (const item of chunk) out.push(item);
  }
  return out;
}

function assignObjectsToZones(
  objects: ObjectBox[],
  zones: ZoneDefinition[],
): {
  zone_summary: FrameState["zone_summary"];
  object_primary_zone: FrameState["object_primary_zone"];
} {
  const sortedZones = [...zones].sort((a, b) => b.priority - a.priority);
  const object_primary_zone: FrameState["object_primary_zone"] = {};
  const zoneBuckets: Record<string, string[]> = {};
  for (const z of sortedZones) {
    zoneBuckets[z.id] = [];
  }
  for (const o of objects) {
    const c = objectCenter(o);
    let chosen: ZoneDefinition | null = null;
    for (const z of sortedZones) {
      const clsOk =
        z.object_classes.length === 0 || z.object_classes.includes(o.className);
      const parentOk =
        z.parent_classes.length === 0 || z.parent_classes.includes(o.className);
      if (!clsOk && !parentOk) continue;
      if (pointInZone(c.x, c.y, z)) {
        chosen = z;
        break;
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
  for (const z of sortedZones) {
    const ids = zoneBuckets[z.id] ?? [];
    zone_summary[z.id] = {
      name: z.name,
      priority: z.priority,
      occupancy: ids.length,
      object_ids: ids,
    };
  }
  return { zone_summary, object_primary_zone };
}

function buildValueRoot(st: FrameState): Record<string, unknown> {
  return {
    frame: st.frame,
    timestamp_ms: st.timestamp_ms,
    page: st.active_page,
    zones: st.zone_summary,
    object_primary_zone: st.object_primary_zone,
    ocr: {
      by_label: st.ocr_by_label,
      boxes: st.ocr_boxes,
    },
    objects: st.objects,
    class_counts: st.class_counts,
  };
}

export function reconstructFrameState(
  frame: number,
  config: ClassificationConfig,
  index: SparseIndex,
  ocrSlice: LoadedParquetSlice | null,
  objSlice: LoadedParquetSlice | null,
  activePageOverride: { id: string; name: string } | null,
): FrameState {
  const ocrIdx = index.ocr;
  const objIdx = index.objects;
  const ocrR = rowRangeForFrame(ocrIdx, ocrSlice, frame);
  const objR = rowRangeForFrame(objIdx, objSlice, frame);
  const ocr_boxes = flattenFrameRows<OcrBox>(ocrSlice, ocrR.start, ocrR.end);
  const objects = flattenFrameRows<ObjectBox>(objSlice, objR.start, objR.end);
  const ocr_by_label: Record<string, OcrBox[]> = {};
  for (const b of ocr_boxes) {
    const k = b.label || "_";
    (ocr_by_label[k] ??= []).push(b);
  }
  const class_counts: Record<string, number> = {};
  for (const o of objects) {
    class_counts[o.className] = (class_counts[o.className] ?? 0) + 1;
  }
  const { zone_summary, object_primary_zone } = assignObjectsToZones(objects, config.zones);
  const timestamp_ms = (frame / config.video.fps) * 1000;
  const base: FrameState = {
    frame,
    timestamp_ms,
    missing: {
      ocr: ocrSlice ? ocr_boxes.length === 0 : true,
      objects: objSlice ? objects.length === 0 : true,
    },
    active_page: activePageOverride,
    zone_summary,
    object_primary_zone,
    ocr_boxes,
    ocr_by_label,
    objects,
    class_counts,
    value_root: {},
  };
  base.value_root = buildValueRoot(base);
  return base;
}

export function resolveActivePage(
  pages: PageDefinition[],
  config: ClassificationConfig,
  index: SparseIndex,
  ocrSlice: LoadedParquetSlice | null,
  objSlice: LoadedParquetSlice | null,
  frame: number,
): { id: string; name: string } | null {
  const stateAt = (f: number) =>
    reconstructFrameState(f, config, index, ocrSlice, objSlice, null);
  const st = stateAt(frame);
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
  index: SparseIndex,
  ocrSlice: LoadedParquetSlice | null,
  objSlice: LoadedParquetSlice | null,
  maxFrame: number,
): FrameStateCache {
  const map = new Map<number, FrameState>();
  const maxEntries = 512;

  const materialize = (fr: number): FrameState => {
    const page = resolveActivePage(config.pages, config, index, ocrSlice, objSlice, fr);
    return reconstructFrameState(fr, config, index, ocrSlice, objSlice, page);
  };

  return {
    get(frame: number) {
      const f = Math.max(0, Math.min(maxFrame, frame));
      if (map.has(f)) return map.get(f)!;
      const st = materialize(f);
      map.set(f, st);
      if (map.size > maxEntries) {
        const first = map.keys().next().value;
        if (first !== undefined) map.delete(first);
      }
      return st;
    },
    prefetch(center: number, half: number) {
      for (let x = center - half; x <= center + half; x++) {
        if (x < 0 || x > maxFrame) continue;
        if (!map.has(x)) map.set(x, materialize(x));
      }
    },
    clear() {
      map.clear();
    },
  };
}

export { rowRangeForFrame };
