import type { ParquetColumnMap } from "@/schemas";

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function has(row: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, k) && row[k] !== undefined;
}

export function pickSampleRows(rows: Record<string, unknown>[], max = 80): Record<string, unknown>[] {
  return rows.slice(0, max).filter((r) => r && typeof r === "object");
}

export function inferFrameColumn(rows: Record<string, unknown>[]): string | null {
  const candidates = [
    "frame",
    "Frame",
    "FRAME",
    "frame_idx",
    "frame_index",
    "frame_id",
    "image_index",
    "image_idx",
    "clip_frame",
    "composition_frame",
    "present_frame",
    "f",
    "idx",
  ];
  for (const row of pickSampleRows(rows)) {
    for (const c of candidates) {
      if (has(row, c) && num(row[c]) !== null) return c;
    }
    for (const k of Object.keys(row)) {
      if (/frame|fidx|fr_idx|image.?idx/i.test(k) && num(row[k]) !== null) return k;
    }
  }
  return null;
}

export type InferredBBox = { x: number; y: number; w: number; h: number };

export function inferBBox(row: Record<string, unknown>): InferredBBox | null {
  const n = num;
  const nested = row.bbox ?? row.box ?? row.det_bbox ?? row.bounds;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const o = nested as Record<string, unknown>;
    const read = (a: string, b: string) => (has(o, a) ? n(o[a]) : has(o, b) ? n(o[b]) : null);
    const x = read("x", "left");
    const y = read("y", "top");
    const w = read("w", "width");
    const h = read("h", "height");
    if (x !== null && y !== null && w !== null && h !== null && w > 0 && h > 0) return { x, y, w, h };
    const x1 = read("x1", "xmin");
    const y1 = read("y1", "ymin");
    const x2 = read("x2", "xmax");
    const y2 = read("y2", "ymax");
    if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    }
  }
  const allNums = (keys: string[]) => keys.every((k) => has(row, k) && n(row[k]) !== null);

  if (allNums(["x1", "y1", "x2", "y2"])) {
    const x1 = n(row.x1)!;
    const y1 = n(row.y1)!;
    const x2 = n(row.x2)!;
    const y2 = n(row.y2)!;
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }
  if (allNums(["xmin", "ymin", "xmax", "ymax"])) {
    const xmin = n(row.xmin)!;
    const ymin = n(row.ymin)!;
    const xmax = n(row.xmax)!;
    const ymax = n(row.ymax)!;
    return { x: xmin, y: ymin, w: Math.max(0, xmax - xmin), h: Math.max(0, ymax - ymin) };
  }
  if (allNums(["left", "top", "right", "bottom"])) {
    const left = n(row.left)!;
    const top = n(row.top)!;
    const right = n(row.right)!;
    const bottom = n(row.bottom)!;
    return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
  }
  if (allNums(["bbox_x", "bbox_y", "bbox_w", "bbox_h"])) {
    return { x: n(row.bbox_x)!, y: n(row.bbox_y)!, w: n(row.bbox_w)!, h: n(row.bbox_h)! };
  }
  if (allNums(["x", "y", "w", "h"])) {
    return { x: n(row.x)!, y: n(row.y)!, w: n(row.w)!, h: n(row.h)! };
  }
  if (allNums(["x", "y", "width", "height"])) {
    return { x: n(row.x)!, y: n(row.y)!, w: n(row.width)!, h: n(row.height)! };
  }
  const bbox = row.bbox ?? row.box ?? row.bounding_box;
  if (Array.isArray(bbox) && bbox.length >= 4) {
    const a = bbox.map((v) => num(v)) as (number | null)[];
    if (a.every((v) => v !== null)) {
      const x1 = a[0]!;
      const y1 = a[1]!;
      const x2 = a[2]!;
      const y2 = a[3]!;
      if (x2 > x1 && y2 > y1) {
        return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      }
      return { x: x1, y: y1, w: a[2]!, h: a[3]! };
    }
  }
  return null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

export function inferClassColumn(row: Record<string, unknown>): string | null {
  const keys = [
    "object_class",
    "class_id",
    "class",
    "Class",
    "label",
    "category",
    "class_name",
    "cls",
    "name",
    "object_type",
    "obj_class",
  ];
  for (const k of keys) if (has(row, k) && str(row[k])) return k;
  for (const [k, v] of Object.entries(row)) {
    if (/class|label|category|type/i.test(k) && typeof v === "string" && v) return k;
  }
  return null;
}

export function inferIdColumn(row: Record<string, unknown>): string | null {
  const keys = ["object_id", "id", "track_id", "instance_id", "entity_id", "obj_id", "det_id", "uuid"];
  for (const k of keys) if (has(row, k)) return k;
  return null;
}

export function inferScoreColumn(row: Record<string, unknown>): string | null {
  const keys = ["object_score", "score", "confidence", "conf", "prob"];
  for (const k of keys) if (has(row, k) && num(row[k]) !== null) return k;
  return null;
}

export function inferOcrTextColumn(row: Record<string, unknown>): string | null {
  const keys = ["ocr_text", "text", "value", "content", "transcript", "string"];
  for (const k of keys) if (has(row, k) && str(row[k])) return k;
  return null;
}

export function inferOcrLabelColumn(row: Record<string, unknown>): string | null {
  const keys = ["ocr_label", "label", "field", "name", "key"];
  for (const k of keys) if (has(row, k) && str(row[k])) return k;
  return null;
}

export function resolveObjectsColumnMap(rows: Record<string, unknown>[], user: ParquetColumnMap): ParquetColumnMap {
  const sample = pickSampleRows(rows)[0];
  if (!sample) return user;
  const frameOk = has(sample, user.frame) && num(sample[user.frame]) !== null;
  const inferredFrame = inferFrameColumn(rows);
  const cls = inferClassColumn(sample);
  const idc = inferIdColumn(sample);
  const sc = inferScoreColumn(sample);

  const out: ParquetColumnMap = { ...user };
  if (!frameOk && inferredFrame) out.frame = inferredFrame;
  if (cls && (!user.object_class || !has(sample, user.object_class))) out.object_class = cls;
  if (idc && (!user.object_id || !has(sample, user.object_id))) out.object_id = idc;
  if (sc && (!user.object_score || !has(sample, user.object_score))) out.object_score = sc;
  return out;
}

export function resolveOcrColumnMap(rows: Record<string, unknown>[], user: ParquetColumnMap): ParquetColumnMap {
  const sample = pickSampleRows(rows)[0];
  if (!sample) return user;
  const frameOk = has(sample, user.frame) && num(sample[user.frame]) !== null;
  const inferredFrame = inferFrameColumn(rows);
  const out: ParquetColumnMap = { ...user };
  if (!frameOk && inferredFrame) out.frame = inferredFrame;
  const tl = inferOcrTextColumn(sample);
  const lb = inferOcrLabelColumn(sample);
  if (tl && (!user.ocr_text || !has(sample, user.ocr_text))) out.ocr_text = tl;
  if (lb && (!user.ocr_label || !has(sample, user.ocr_label))) out.ocr_label = lb;
  const gx = ["ocr_x", "x", "left", "bbox_x"];
  const gy = ["ocr_y", "y", "top", "bbox_y"];
  const gw = ["ocr_w", "w", "width", "bbox_w"];
  const gh = ["ocr_h", "h", "height", "bbox_h"];
  const pick = (cands: string[]) => cands.find((k) => has(sample, k) && num(sample[k]) !== null);
  const xk = pick(gx);
  const yk = pick(gy);
  const wk = pick(gw);
  const hk = pick(gh);
  if (xk && yk && wk && hk) {
    if (!user.ocr_x || !has(sample, user.ocr_x)) out.ocr_x = xk;
    if (!user.ocr_y || !has(sample, user.ocr_y)) out.ocr_y = yk;
    if (!user.ocr_w || !has(sample, user.ocr_w)) out.ocr_w = wk;
    if (!user.ocr_h || !has(sample, user.ocr_h)) out.ocr_h = hk;
  }
  const cf = inferScoreColumn(sample);
  if (cf && (!user.ocr_confidence || !has(sample, user.ocr_confidence))) out.ocr_confidence = cf;
  return out;
}
