export type Provenance = "observed" | "carried";

export type OcrBox = {
  label: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number | null;
  /** Present after forward-reconstruction: observed at this frame vs carried from prior */
  provenance?: Provenance;
};

export type ObjectBox = {
  id: string;
  className: string;
  score: number | null;
  x: number;
  y: number;
  w: number;
  h: number;
  metadata: Record<string, unknown>;
  provenance?: Provenance;
};

export type ZoneHitInfo = {
  zoneId: string;
  zoneName: string;
  priority: number;
};

export type FrameState = {
  frame: number;
  timestamp_ms: number;
  missing: {
    ocr: boolean;
    objects: boolean;
  };
  /** Counts of forward-filled / TTL-filtered data at this frame */
  reconstruction_stats: {
    ocr: { observed: number; carried: number };
    objects: { observed: number; carried: number; dropped_ttl: number };
  };
  /** True when this exact frame is a key in the loaded sparse OCR / objects parquets */
  sparse_observation: { ocr: boolean; objects: boolean };
  active_page: { id: string; name: string } | null;
  /** Per zone id: objects whose center falls in zone; deterministic highest-priority zone per object */
  zone_summary: Record<
    string,
    {
      name: string;
      priority: number;
      occupancy: number;
      object_ids: string[];
    }
  >;
  /** Primary zone assignment per object id */
  object_primary_zone: Record<string, ZoneHitInfo | null>;
  ocr_boxes: OcrBox[];
  ocr_by_label: Record<string, OcrBox[]>;
  objects: ObjectBox[];
  class_counts: Record<string, number>;
  /** JSON-serializable snapshot for predicate / wasm */
  value_root: Record<string, unknown>;
};

export type LoadedParquetSlice = {
  role: "ocr" | "objects";
  /** Sorted by frame ascending */
  frames: number[];
  rows: unknown[][];
};
