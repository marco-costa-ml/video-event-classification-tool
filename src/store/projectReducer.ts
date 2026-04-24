import type { ClassificationConfig } from "@/schemas";
import BUILTIN_OCR_LAYOUT from "@/data/ocrLayout.json";
import type { TimelineEvent } from "@/schemas/labels";
import type { LoadedParquetSlice } from "@/domain/types";
import { createFrameStateCache } from "@/domain/frameReconstruction";
import { runEventDetection, type FiredEvent } from "@/domain/eventEngine";
import { collapsePredictedEvents } from "@/domain/eventDedupe";
import { evaluateTimeline, type EvaluationReport } from "@/evaluation/metrics";
import { classificationConfigSchema } from "@/schemas";
import { SAMPLE_CONFIG, SAMPLE_OCR, SAMPLE_OBJECTS } from "@/data/builtinSample";
import { reconcileVideoTimeline, type VideoIntrinsics } from "@/domain/timelineReconcile";
import { clipSliceToMaxFrame, maxFramesForWindow } from "@/domain/timelineWindow";

export type OcrLayoutEntry = { x: number; y: number; w: number; h: number };
export type OcrLayout = Record<string, OcrLayoutEntry>;

export function parseOcrLayoutJson(json: unknown): OcrLayout {
  const out: OcrLayout = {};
  const obj = json as { boxes?: Array<{ label: string; bbox: number[] }> };
  for (const b of obj.boxes ?? []) {
    const [x1, y1, x2, y2] = b.bbox as [number, number, number, number];
    out[b.label] = { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
  }
  return out;
}

export const BUILTIN_OCR_LAYOUT_PARSED: OcrLayout = parseOcrLayoutJson(BUILTIN_OCR_LAYOUT);

export type LayerToggles = {
  ocr: boolean;
  objects: boolean;
  zones: boolean;
  pages: boolean;
  labels: boolean;
  predictions: boolean;
  groundTruth: boolean;
};

export type ProjectState = {
  config: ClassificationConfig;
  ocr: LoadedParquetSlice | null;
  objects: LoadedParquetSlice | null;
  ocrLayout: OcrLayout | null;
  videoUrl: string | null;
  currentFrame: number;
  layers: LayerToggles;
  manualLabels: TimelineEvent[];
  predicted: TimelineEvent[];
  firedByFrame: Map<number, FiredEvent[]>;
  evaluation: EvaluationReport | null;
  evalTolerance: number;
  lastError: string | null;
  revision: number;
};

export type ProjectAction =
  | { type: "hydrate"; state: ProjectState }
  | { type: "load_sample" }
  | { type: "load_config"; config: ClassificationConfig }
  | { type: "set_ocr"; slice: LoadedParquetSlice | null }
  | { type: "set_objects"; slice: LoadedParquetSlice | null }
  | { type: "set_video_url"; url: string | null }
  | { type: "sync_video_intrinsics"; intrinsics: VideoIntrinsics }
  | { type: "set_frame"; frame: number }
  | { type: "toggle_layer"; key: keyof LayerToggles }
  | { type: "set_layers"; layers: Partial<LayerToggles> }
  | { type: "update_config"; config: ClassificationConfig }
  | { type: "run_detection" }
  | { type: "run_evaluation" }
  | { type: "set_eval_tolerance"; tolerance: number }
  | { type: "add_manual_label"; label: TimelineEvent }
  | { type: "delete_manual_label"; id: string }
  | { type: "set_error"; message: string | null }
  | { type: "set_ocr_layout"; layout: OcrLayout | null };

function maxFrameOf(s: ProjectState): number {
  return Math.max(0, s.config.video.frame_count - 1);
}

export function recomputeDetection(s: ProjectState): Pick<ProjectState, "predicted" | "firedByFrame"> {
  const cache = createFrameStateCache(s.config, s.ocr, s.objects, maxFrameOf(s));
  const { firedByFrame, timeline } = runEventDetection(s.config, cache, maxFrameOf(s));
  const predicted = collapsePredictedEvents(timeline, s.config.events);
  return { firedByFrame, predicted };
}

function applyReconciled(
  state: ProjectState,
  next: Pick<ProjectState, "config" | "ocr" | "objects">,
  intrinsics?: VideoIntrinsics | null,
): ProjectState {
  const cfg = reconcileVideoTimeline(next.config, { ocr: next.ocr, objects: next.objects }, intrinsics ?? undefined);
  const maxWindowFrame = maxFramesForWindow(cfg.video.fps) - 1;
  const clippedOcr = clipSliceToMaxFrame(next.ocr, maxWindowFrame);
  const clippedObjects = clipSliceToMaxFrame(next.objects, maxWindowFrame);
  const maxF = Math.max(0, cfg.video.frame_count - 1);
  const currentFrame = Math.min(state.currentFrame, maxF);
  const merged: ProjectState = {
    ...state,
    config: cfg,
    ocr: clippedOcr,
    objects: clippedObjects,
    currentFrame,
    lastError: null,
  };
  return { ...merged, ...recomputeDetection(merged), revision: state.revision + 1, evaluation: null };
}

export function initialSampleState(): ProjectState {
  const base = createInitialState(SAMPLE_CONFIG);
  const next: ProjectState = {
    ...base,
    ocr: SAMPLE_OCR,
    objects: SAMPLE_OBJECTS,
    ocrLayout: BUILTIN_OCR_LAYOUT_PARSED,
    evaluation: null,
    lastError: null,
    currentFrame: 0,
  };
  return { ...next, ...recomputeDetection(next), revision: 1 };
}

export function createInitialState(config: ClassificationConfig): ProjectState {
  const base: ProjectState = {
    config,
    ocr: null,
    objects: null,
    ocrLayout: null,
    videoUrl: null,
    currentFrame: 0,
    layers: {
      ocr: true,
      objects: true,
      zones: true,
      pages: true,
      labels: true,
      predictions: true,
      groundTruth: true,
    },
    manualLabels: [],
    predicted: [],
    firedByFrame: new Map(),
    evaluation: null,
    evalTolerance: 5,
    lastError: null,
    revision: 0,
  };
  const det = recomputeDetection(base);
  return { ...base, ...det, revision: 1 };
}

export function projectReducer(state: ProjectState, action: ProjectAction): ProjectState {
  switch (action.type) {
    case "hydrate":
      return action.state;
    case "load_sample":
      return { ...initialSampleState(), revision: state.revision + 1 };
    case "set_error":
      return { ...state, lastError: action.message };
    case "set_ocr_layout":
      return { ...state, ocrLayout: action.layout };
    case "load_config": {
      const cfg0 = action.config;
      const cfg = reconcileVideoTimeline(cfg0, { ocr: state.ocr, objects: state.objects }, null);
      const maxF = Math.max(0, cfg.video.frame_count - 1);
      const currentFrame = Math.min(state.currentFrame, maxF);
      const next = { ...state, config: cfg, currentFrame, lastError: null };
      return { ...next, ...recomputeDetection(next), revision: state.revision + 1, evaluation: null };
    }
    case "update_config": {
      return applyReconciled(state, { config: action.config, ocr: state.ocr, objects: state.objects }, null);
    }
    case "set_ocr":
      return applyReconciled(state, { config: state.config, ocr: action.slice, objects: state.objects }, null);
    case "set_objects":
      return applyReconciled(state, { config: state.config, ocr: state.ocr, objects: action.slice }, null);
    case "set_video_url":
      return { ...state, videoUrl: action.url };
    case "sync_video_intrinsics":
      return applyReconciled(
        state,
        { config: state.config, ocr: state.ocr, objects: state.objects },
        action.intrinsics,
      );
    case "set_frame": {
      const f = Math.max(0, Math.min(maxFrameOf(state), Math.floor(action.frame)));
      return { ...state, currentFrame: f };
    }
    case "toggle_layer":
      return {
        ...state,
        layers: { ...state.layers, [action.key]: !state.layers[action.key] },
      };
    case "set_layers":
      return { ...state, layers: { ...state.layers, ...action.layers } };
    case "add_manual_label":
      return {
        ...state,
        manualLabels: [...state.manualLabels, action.label],
        evaluation: null,
      };
    case "delete_manual_label":
      return {
        ...state,
        manualLabels: state.manualLabels.filter((l) => l.id !== action.id),
        evaluation: null,
      };
    case "set_eval_tolerance":
      return { ...state, evalTolerance: action.tolerance };
    case "run_detection": {
      const det = recomputeDetection(state);
      return { ...state, ...det, revision: state.revision + 1, evaluation: null };
    }
    case "run_evaluation": {
      const rep = evaluateTimeline(state.manualLabels, state.predicted, state.evalTolerance);
      return { ...state, evaluation: rep };
    }
    default:
      return state;
  }
}

export function parseConfigFileText(text: string): ClassificationConfig {
  const json = JSON.parse(text) as unknown;
  return classificationConfigSchema.parse(json);
}
