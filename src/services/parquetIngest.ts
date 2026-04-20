import { parquetReadObjects } from "hyparquet";
import type { ClassificationConfig, ParquetColumnMap } from "@/schemas";
import type { LoadedParquetSlice, ObjectBox, OcrBox } from "@/domain/types";

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function getCol(row: Record<string, unknown>, key: string | undefined): unknown {
  if (!key) return undefined;
  return row[key];
}

async function readParquetRows(buffer: ArrayBuffer): Promise<Record<string, unknown>[]> {
  /** ArrayBuffer is a valid AsyncBuffer for in-memory files (hyparquet docs). */
  const rows = await parquetReadObjects({ file: buffer });
  return rows as Record<string, unknown>[];
}

function parseOcrRows(
  rows: Record<string, unknown>[],
  map: ParquetColumnMap,
): { frames: number[]; data: OcrBox[] } {
  const frames: number[] = [];
  const data: OcrBox[] = [];
  for (const row of rows) {
    const f = num(getCol(row, map.frame));
    if (f === null) continue;
    const frame = Math.round(f);
    frames.push(frame);
    data.push({
      label: str(getCol(row, map.ocr_label)) ?? "",
      text: str(getCol(row, map.ocr_text)) ?? "",
      x: num(getCol(row, map.ocr_x)) ?? 0,
      y: num(getCol(row, map.ocr_y)) ?? 0,
      w: num(getCol(row, map.ocr_w)) ?? 0,
      h: num(getCol(row, map.ocr_h)) ?? 0,
      confidence: num(getCol(row, map.ocr_confidence)),
    });
  }
  return { frames, data };
}

function parseObjectRows(
  rows: Record<string, unknown>[],
  map: ParquetColumnMap,
): { frames: number[]; data: ObjectBox[] } {
  const frames: number[] = [];
  const data: ObjectBox[] = [];
  for (const row of rows) {
    const f = num(getCol(row, map.frame));
    if (f === null) continue;
    const frame = Math.round(f);
    frames.push(frame);
    const id = str(getCol(row, map.object_id)) ?? `obj_${frame}_${data.length}`;
    const meta: Record<string, unknown> = {};
    if (map.page_hint) {
      const ph = getCol(row, map.page_hint);
      if (ph !== undefined) meta.page_hint = ph;
    }
    data.push({
      id,
      className: str(getCol(row, map.object_class)) ?? "",
      score: num(getCol(row, map.object_score)),
      x: num(getCol(row, map.bbox_x)) ?? 0,
      y: num(getCol(row, map.bbox_y)) ?? 0,
      w: num(getCol(row, map.bbox_w)) ?? 0,
      h: num(getCol(row, map.bbox_h)) ?? 0,
      metadata: meta,
    });
  }
  return { frames, data };
}

function sortAndMergeFrames<T>(frames: number[], data: T[]): { frames: number[]; rows: T[][] } {
  const order = frames.map((_, i) => i).sort((a, b) => frames[a]! - frames[b]!);
  const mergedFrames: number[] = [];
  const mergedRows: T[][] = [];
  for (const i of order) {
    const fr = frames[i]!;
    const row = data[i]!;
    if (mergedFrames.length && mergedFrames[mergedFrames.length - 1] === fr) {
      mergedRows[mergedRows.length - 1]!.push(row);
    } else {
      mergedFrames.push(fr);
      mergedRows.push([row]);
    }
  }
  return { frames: mergedFrames, rows: mergedRows };
}

export async function loadParquetOcr(
  buffer: ArrayBuffer,
  config: ClassificationConfig,
): Promise<LoadedParquetSlice | null> {
  const map = config.parquet.ocr;
  if (!map) return null;
  const rows = await readParquetRows(buffer);
  const parsed = parseOcrRows(rows, map);
  const sorted = sortAndMergeFrames(parsed.frames, parsed.data);
  return {
    role: "ocr",
    frames: sorted.frames,
    rows: sorted.rows,
  };
}

export async function loadParquetObjects(
  buffer: ArrayBuffer,
  config: ClassificationConfig,
): Promise<LoadedParquetSlice | null> {
  const map = config.parquet.objects;
  if (!map) return null;
  const rows = await readParquetRows(buffer);
  const parsed = parseObjectRows(rows, map);
  const sorted = sortAndMergeFrames(parsed.frames, parsed.data);
  return {
    role: "objects",
    frames: sorted.frames,
    rows: sorted.rows,
  };
}
