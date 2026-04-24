import React, { createContext, useCallback, useContext, useMemo, useReducer, useRef } from "react";
import type { EventDefinition } from "@/schemas/events";
import type { FrameState } from "@/domain/types";
import { loadParquetOcr, loadParquetObjects } from "@/services/parquetIngest";
import {
  projectReducer,
  parseConfigFileText,
  parseOcrLayoutJson,
  BUILTIN_OCR_LAYOUT_PARSED,
  initialSampleState,
  type ProjectState,
  type ProjectAction,
} from "@/store/projectReducer";
import { createFrameStateCache } from "@/domain/frameReconstruction";
import { evaluatePredicate, type EvalContext } from "@/domain/predicateEval";

type Ctx = {
  state: ProjectState;
  dispatch: React.Dispatch<ProjectAction>;
  loadSample: () => void;
  loadConfigFile: (file: File) => Promise<void>;
  loadOcrParquet: (file: File) => Promise<void>;
  loadObjectsParquet: (file: File) => Promise<void>;
  loadVideoFile: (file: File) => void;
  loadOcrLayoutFile: (file: File) => Promise<void>;
  loadBuiltinOcrLayout: () => void;
  frameState: FrameState;
  /** Resolve FrameState at any frame index (uses the shared reconstruction cache). */
  stateAt: (frame: number) => FrameState;
  predicateStatus: (defs: EventDefinition[]) => { id: string; name: string; satisfied: boolean }[];
};

const ProjectContext = createContext<Ctx | null>(null);

function initProject(): ProjectState {
  return initialSampleState();
}

function useFrameBundle(state: ProjectState) {
  const cacheRef = useRef<ReturnType<typeof createFrameStateCache> | null>(null);
  const cacheKeyRef = useRef<string>("");

  const cacheKey = useMemo(() => {
    const ocrRows = state.ocr?.frames.length ?? 0;
    const objRows = state.objects?.frames.length ?? 0;
    return [
      state.revision,
      state.config.video.frame_count,
      state.config.video.fps,
      state.config.reconstruction?.object_ttl_frames ?? 2,
      state.config.reconstruction?.ocr_ttl_frames ?? 5,
      state.config.pages.length,
      state.config.zones.length,
      state.ocr ? `ocr:${ocrRows}` : "ocr:none",
      state.objects ? `obj:${objRows}` : "obj:none",
    ].join("|");
  }, [state]);

  if (!cacheRef.current || cacheKeyRef.current !== cacheKey) {
    const maxF = Math.max(0, state.config.video.frame_count - 1);
    cacheRef.current = createFrameStateCache(state.config, state.ocr, state.objects, maxF);
    cacheKeyRef.current = cacheKey;
  }

  const cache = cacheRef.current;
  cache.prefetch(state.currentFrame, 20);
  const st = cache.get(state.currentFrame);
  const stateAt = (f: number) => cache.get(f);
  const ctx: EvalContext = {
    evalFrame: state.currentFrame,
    lastMatchFrame: null,
    stateAt,
  };
  return { st, ctx };
}

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(projectReducer, undefined, initProject);
  const videoObjectUrlRef = useRef<string | null>(null);

  const loadSample = useCallback(() => {
    dispatch({ type: "load_sample" });
  }, []);

  const loadConfigFile = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const cfg = parseConfigFileText(text);
      dispatch({ type: "load_config", config: cfg });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      dispatch({ type: "set_error", message: `Config: ${msg}` });
    }
  }, []);

  const loadOcrParquet = useCallback(
    async (file: File) => {
      try {
        if (!state.config.parquet.ocr) {
          dispatch({
            type: "set_error",
            message: 'Classification config is missing parquet.ocr (column map). Add it to import OCR parquet.',
          });
          return;
        }
        const buf = await file.arrayBuffer();
        const slice = await loadParquetOcr(buf, state.config);
        if (!slice) {
          dispatch({ type: "set_error", message: "OCR parquet: load returned empty (check column map)." });
          return;
        }
        dispatch({ type: "set_ocr", slice });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        dispatch({ type: "set_error", message: `OCR parquet: ${msg}` });
      }
    },
    [state.config],
  );

  const loadObjectsParquet = useCallback(
    async (file: File) => {
      try {
        if (!state.config.parquet.objects) {
          dispatch({
            type: "set_error",
            message:
              'Classification config is missing parquet.objects (column map). Add it under "parquet"."objects" to import object parquet.',
          });
          return;
        }
        const buf = await file.arrayBuffer();
        const slice = await loadParquetObjects(buf, state.config);
        if (!slice) {
          dispatch({ type: "set_error", message: "Objects parquet: load returned empty (check column map)." });
          return;
        }
        dispatch({ type: "set_objects", slice });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        dispatch({ type: "set_error", message: `Objects parquet: ${msg}` });
      }
    },
    [state.config],
  );

  const loadOcrLayoutFile = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const json = JSON.parse(text) as unknown;
      const layout = parseOcrLayoutJson(json);
      dispatch({ type: "set_ocr_layout", layout });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      dispatch({ type: "set_error", message: `OCR layout: ${msg}` });
    }
  }, []);

  const loadBuiltinOcrLayout = useCallback(() => {
    dispatch({ type: "set_ocr_layout", layout: BUILTIN_OCR_LAYOUT_PARSED });
  }, []);

  const loadVideoFile = useCallback((file: File) => {
    if (videoObjectUrlRef.current) {
      URL.revokeObjectURL(videoObjectUrlRef.current);
      videoObjectUrlRef.current = null;
    }
    const url = URL.createObjectURL(file);
    videoObjectUrlRef.current = url;
    dispatch({ type: "set_video_url", url });
  }, []);

  const bundle = useFrameBundle(state);

  const predicateStatus = useCallback(
    (defs: EventDefinition[]) =>
      defs.map((d) => ({
        id: d.id,
        name: d.name,
        satisfied: evaluatePredicate(d.predicate, bundle.st, bundle.st.frame, bundle.ctx),
      })),
    [bundle],
  );

  const value = useMemo(
    () => ({
      state,
      dispatch,
      loadSample,
      loadConfigFile,
      loadOcrParquet,
      loadObjectsParquet,
      loadVideoFile,
      loadOcrLayoutFile,
      loadBuiltinOcrLayout,
      frameState: bundle.st,
      stateAt: bundle.ctx.stateAt,
      predicateStatus,
    }),
    [
      state,
      dispatch,
      loadSample,
      loadConfigFile,
      loadOcrParquet,
      loadObjectsParquet,
      loadVideoFile,
      loadOcrLayoutFile,
      loadBuiltinOcrLayout,
      bundle.st,
      bundle.ctx.stateAt,
      predicateStatus,
    ],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject() {
  const v = useContext(ProjectContext);
  if (!v) throw new Error("useProject outside ProjectProvider");
  return v;
}
