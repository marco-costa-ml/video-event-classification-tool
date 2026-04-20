/**
 * Parquet export is intentionally isolated from the UI.
 *
 * Browser-native Parquet writing is non-trivial; this module defines the stable
 * interchange contract used by the app today:
 * - `exportEventsAsJsonlForParquetPipeline` (see `exportService.ts`) emits JSON Lines.
 * - Offline conversion to `.parquet` can be done with DuckDB, Polars, pyarrow, etc.
 *
 * If you add true Parquet bytes generation later, keep it behind a single function
 * like `encodeEventsParquet(events: TimelineEvent[]): Uint8Array`.
 */

export type ParquetExportColumn = {
  name: string;
  /** Logical type hint for encoders */
  type: "int32" | "int64" | "float" | "string" | "bool";
};

export const EVENT_PARQUET_SCHEMA: ParquetExportColumn[] = [
  { name: "id", type: "string" },
  { name: "kind", type: "string" },
  { name: "event_name", type: "string" },
  { name: "start_frame", type: "int32" },
  { name: "end_frame", type: "int32" },
  { name: "source", type: "string" },
];
