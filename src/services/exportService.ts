import type { EvaluationReport } from "@/evaluation/metrics";
import type { ClassificationConfig } from "@/schemas";
import type { TimelineEvent } from "@/schemas/labels";

function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportClassificationJson(config: ClassificationConfig, filename = "classification.json") {
  downloadText(filename, JSON.stringify(config, null, 2), "application/json");
}

export function exportTimelineJson(events: TimelineEvent[], filename: string) {
  downloadText(filename, JSON.stringify(events, null, 2), "application/json");
}

export function exportEvaluationReport(report: EvaluationReport, filename = "evaluation_report.json") {
  downloadText(filename, JSON.stringify(report, null, 2), "application/json");
}

/**
 * Browser-native Parquet writing is intentionally isolated. Today this exports JSONL
 * with the same logical columns an offline tool can turn into Parquet.
 */
export function exportEventsAsJsonlForParquetPipeline(events: TimelineEvent[], filename = "events.jsonl") {
  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  downloadText(filename, lines, "application/x-ndjson");
}
