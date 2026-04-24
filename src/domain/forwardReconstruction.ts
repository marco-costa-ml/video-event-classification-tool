import type { OcrBox, ObjectBox, LoadedParquetSlice, Provenance } from "./types";

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

type LabelTimeline = { frames: number[]; boxSets: OcrBox[][] };

function buildOcrLabelTimelines(ocr: LoadedParquetSlice | null): Map<string, LabelTimeline> {
  const m = new Map<string, LabelTimeline>();
  if (!ocr?.frames.length) return m;
  for (let i = 0; i < ocr.frames.length; i++) {
    const fr = ocr.frames[i]!;
    const chunk = ocr.rows[i] as OcrBox[];
    const byLabel = new Map<string, OcrBox[]>();
    for (const b of chunk) {
      const key = b.label || "_";
      if (!byLabel.has(key)) byLabel.set(key, []);
      byLabel.get(key)!.push(b);
    }
    for (const [label, boxes] of byLabel) {
      const tl = m.get(label) ?? { frames: [], boxSets: [] };
      tl.frames.push(fr);
      tl.boxSets.push(
        boxes.map((b) => ({
          ...b,
          label: b.label,
          text: b.text,
          x: b.x,
          y: b.y,
          w: b.w,
          h: b.h,
          confidence: b.confidence,
        })),
      );
      m.set(label, tl);
    }
  }
  return m;
}

type ObjectTrack = { frames: number[]; boxes: ObjectBox[] };

function buildObjectTracks(objects: LoadedParquetSlice | null): Map<string, ObjectTrack> {
  const m = new Map<string, ObjectTrack>();
  if (!objects?.frames.length) return m;
  for (let i = 0; i < objects.frames.length; i++) {
    const fr = objects.frames[i]!;
    const chunk = objects.rows[i] as ObjectBox[];
    const lastById = new Map<string, ObjectBox>();
    for (const ob of chunk) {
      lastById.set(ob.id, ob);
    }
    for (const ob of lastById.values()) {
      const tl = m.get(ob.id) ?? { frames: [], boxes: [] };
      tl.frames.push(fr);
      tl.boxes.push({ ...ob, metadata: { ...ob.metadata } });
      m.set(ob.id, tl);
    }
  }
  return m;
}

export type OcrAtFrame = {
  ocr_by_label: Record<string, OcrBox[]>;
  ocr_boxes: OcrBox[];
  labelProvenance: Record<string, Provenance>;
  boxProvenance: Provenance[];
  stats: { observed: number; carried: number };
};

export function queryOcrAtFrame(labelTimelines: Map<string, LabelTimeline>, f: number, ocrTtlFrames: number): OcrAtFrame {
  const ocr_by_label: Record<string, OcrBox[]> = {};
  const ocr_boxes: OcrBox[] = [];
  const labelProvenance: Record<string, Provenance> = {};
  const boxProvenance: Provenance[] = [];
  let observed = 0;
  let carried = 0;
  for (const [label, tl] of labelTimelines) {
    const ix = rightmostLte(tl.frames, f);
    if (ix < 0) continue;
    const t = tl.frames[ix]!;
    if (f - t > ocrTtlFrames) continue;
    const prov: Provenance = t === f ? "observed" : "carried";
    if (prov === "observed") observed += tl.boxSets[ix]!.length;
    else carried += tl.boxSets[ix]!.length;
    const boxes = tl.boxSets[ix]!.map((b) => ({
      ...b,
      provenance: prov,
    }));
    ocr_by_label[label] = boxes;
    labelProvenance[label] = prov;
    for (const b of boxes) {
      ocr_boxes.push(b);
      boxProvenance.push(prov);
    }
  }
  return { ocr_by_label, ocr_boxes, labelProvenance, boxProvenance, stats: { observed, carried } };
}

export type ObjectsAtFrame = {
  objects: ObjectBox[];
  stats: { observed: number; carried: number; dropped_ttl: number };
};

export function queryObjectsAtFrame(tracks: Map<string, ObjectTrack>, f: number, ttlFrames: number): ObjectsAtFrame {
  const out: ObjectBox[] = [];
  let observed = 0;
  let carried = 0;
  let dropped_ttl = 0;
  for (const [id, tr] of tracks) {
    const ix = rightmostLte(tr.frames, f);
    if (ix < 0) continue;
    const t = tr.frames[ix]!;
    if (f - t > ttlFrames) {
      dropped_ttl++;
      continue;
    }
    const prov: Provenance = t === f ? "observed" : "carried";
    if (prov === "observed") observed++;
    else carried++;
    const b = { ...tr.boxes[ix]!, id, metadata: { ...tr.boxes[ix]!.metadata }, provenance: prov };
    out.push(b);
  }
  return { objects: out, stats: { observed, carried, dropped_ttl } };
}

/** O(maxFrame + sparse_rows): forward-fill OCR per label without per-query scans over all labels. */
function precomputeOcrDense(ocr: LoadedParquetSlice | null, ocrTtlFrames: number, maxFrame: number): OcrAtFrame[] | null {
  if (!ocr?.frames.length) return null;
  const n = Math.max(0, Math.floor(maxFrame)) + 1;
  const out: OcrAtFrame[] = new Array(n);
  const labelState = new Map<string, { lastFr: number; boxes: OcrBox[] }>();
  let sparseIdx = 0;

  for (let f = 0; f < n; f++) {
    while (sparseIdx < ocr.frames.length && ocr.frames[sparseIdx]! === f) {
      const chunk = ocr.rows[sparseIdx]! as OcrBox[];
      const byLabel = new Map<string, OcrBox[]>();
      for (const b of chunk) {
        const key = b.label || "_";
        if (!byLabel.has(key)) byLabel.set(key, []);
        byLabel.get(key)!.push(b);
      }
      for (const [label, boxes] of byLabel) {
        labelState.set(label, {
          lastFr: f,
          boxes: boxes.map((b) => ({
            ...b,
            label: b.label,
            text: b.text,
            x: b.x,
            y: b.y,
            w: b.w,
            h: b.h,
            confidence: b.confidence,
          })),
        });
      }
      sparseIdx++;
    }

    const ocr_by_label: Record<string, OcrBox[]> = {};
    const ocr_boxes: OcrBox[] = [];
    const labelProvenance: Record<string, Provenance> = {};
    const boxProvenance: Provenance[] = [];
    let observed = 0;
    let carried = 0;
    for (const [label, st] of labelState) {
      if (f - st.lastFr > ocrTtlFrames) continue;
      const prov: Provenance = st.lastFr === f ? "observed" : "carried";
      if (prov === "observed") observed += st.boxes.length;
      else carried += st.boxes.length;
      const boxes = st.boxes.map((b) => ({ ...b, provenance: prov }));
      ocr_by_label[label] = boxes;
      labelProvenance[label] = prov;
      for (const b of boxes) {
        ocr_boxes.push(b);
        boxProvenance.push(prov);
      }
    }
    out[f] = { ocr_by_label, ocr_boxes, labelProvenance, boxProvenance, stats: { observed, carried } };
  }
  return out;
}

type ActiveOb = { box: ObjectBox; lastObs: number };

/** O(maxFrame + sparse_rows): TTL + forward carry without scanning every track id per frame. */
function precomputeObjectsDense(
  objects: LoadedParquetSlice | null,
  ttlFrames: number,
  maxFrame: number,
): ObjectsAtFrame[] | null {
  if (!objects?.frames.length) return null;
  const ttl = Math.max(0, Math.floor(ttlFrames));
  const n = Math.max(0, Math.floor(maxFrame)) + 1;
  const out: ObjectsAtFrame[] = new Array(n);
  const active = new Map<string, ActiveOb>();
  let sparseIdx = 0;

  for (let f = 0; f < n; f++) {
    let dropped_ttl = 0;
    for (const [id, e] of active) {
      if (f - e.lastObs > ttl) {
        active.delete(id);
        dropped_ttl++;
      }
    }

    while (sparseIdx < objects.frames.length && objects.frames[sparseIdx]! === f) {
      const chunk = objects.rows[sparseIdx]! as ObjectBox[];
      const lastById = new Map<string, ObjectBox>();
      for (const ob of chunk) {
        lastById.set(ob.id, ob);
      }
      for (const ob of lastById.values()) {
        active.set(ob.id, {
          box: { ...ob, id: ob.id, metadata: { ...ob.metadata } },
          lastObs: f,
        });
      }
      sparseIdx++;
    }

    const list: ObjectBox[] = [];
    let observed = 0;
    let carried = 0;
    for (const [id, e] of active) {
      const prov: Provenance = e.lastObs === f ? "observed" : "carried";
      if (prov === "observed") observed++;
      else carried++;
      list.push({ ...e.box, id, metadata: { ...e.box.metadata }, provenance: prov });
    }
    out[f] = { objects: list, stats: { observed, carried, dropped_ttl } };
  }
  return out;
}

export type ForwardReconstruction = {
  ocrTimelines: Map<string, LabelTimeline>;
  objectTracks: Map<string, ObjectTrack>;
  ocrTtlFrames: number;
  objectTtlFrames: number;
  maxFrame: number;
  /** When set, O(1) OCR lookup per frame (preferred). */
  ocrDense: OcrAtFrame[] | null;
  /** When set, O(1) object lookup per frame (preferred). */
  objectsDense: ObjectsAtFrame[] | null;
  ocrFrameCache: Map<number, OcrAtFrame>;
  objectFrameCache: Map<number, ObjectsAtFrame>;
};

export function buildForwardReconstruction(
  ocr: LoadedParquetSlice | null,
  objects: LoadedParquetSlice | null,
  ocrTtlFrames: number,
  objectTtlFrames: number,
  maxFrame: number,
): ForwardReconstruction {
  const mf = Math.max(0, Math.floor(maxFrame));
  const ocrDense = precomputeOcrDense(ocr, ocrTtlFrames, mf);
  const objectsDense = precomputeObjectsDense(objects, objectTtlFrames, mf);
  return {
    ocrTimelines: ocrDense ? new Map() : buildOcrLabelTimelines(ocr),
    objectTracks: objectsDense ? new Map() : buildObjectTracks(objects),
    ocrTtlFrames: Math.max(0, ocrTtlFrames),
    objectTtlFrames: Math.max(0, objectTtlFrames),
    maxFrame: mf,
    ocrDense,
    objectsDense,
    ocrFrameCache: new Map<number, OcrAtFrame>(),
    objectFrameCache: new Map<number, ObjectsAtFrame>(),
  };
}

function maybeEvictOldest<T>(m: Map<number, T>, maxEntries: number) {
  if (m.size <= maxEntries) return;
  const first = m.keys().next().value;
  if (first !== undefined) m.delete(first);
}

export function queryOcrAtFrameCached(forward: ForwardReconstruction, frame: number): OcrAtFrame {
  const key = Math.max(0, Math.min(forward.maxFrame, Math.floor(frame)));
  if (forward.ocrDense) return forward.ocrDense[key]!;
  const cached = forward.ocrFrameCache.get(key);
  if (cached) return cached;
  const computed = queryOcrAtFrame(forward.ocrTimelines, key, forward.ocrTtlFrames);
  forward.ocrFrameCache.set(key, computed);
  maybeEvictOldest(forward.ocrFrameCache, 1024);
  return computed;
}

export function queryObjectsAtFrameCached(forward: ForwardReconstruction, frame: number): ObjectsAtFrame {
  const key = Math.max(0, Math.min(forward.maxFrame, Math.floor(frame)));
  if (forward.objectsDense) return forward.objectsDense[key]!;
  const cached = forward.objectFrameCache.get(key);
  if (cached) return cached;
  const computed = queryObjectsAtFrame(forward.objectTracks, key, forward.objectTtlFrames);
  forward.objectFrameCache.set(key, computed);
  maybeEvictOldest(forward.objectFrameCache, 1024);
  return computed;
}
