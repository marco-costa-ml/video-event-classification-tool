import React, { createContext, useCallback, useContext, useMemo, useReducer } from "react";
import type { EventDefinition } from "@/schemas/events";
import type { FrameState } from "@/domain/types";
import { loadParquetOcr, loadParquetObjects } from "@/services/parquetIngest";
import {
  projectReducer,
  parseConfigFileText,
  initialSampleState,
  type ProjectState,
  type ProjectAction,
} from "@/store/projectReducer";
import { buildSparseIndex } from "@/domain/sparseIndex";
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
  frameState: FrameState;
  predicateStatus: (defs: EventDefinition[]) => { id: string; name: string; satisfied: boolean }[];
};

const ProjectContext = createContext<Ctx | null>(null);

function initProject(): ProjectState {
  return initialSampleState();
}

function useFrameBundle(state: ProjectState) {
  return useMemo(() => {
    const index = buildSparseIndex({ ocr: state.ocr, objects: state.objects });
    const maxF = Math.max(0, state.config.video.frame_count - 1);
    const cache = createFrameStateCache(state.config, index, state.ocr, state.objects, maxF);
    cache.prefetch(state.currentFrame, 16);
    const st = cache.get(state.currentFrame);
    const stateAt = (f: number) => cache.get(f);
    const ctx: EvalContext = {
      evalFrame: state.currentFrame,
      lastMatchFrame: null,
      stateAt,
    };
    return { st, ctx };
  }, [state.config, state.ocr, state.objects, state.currentFrame, state.revision]);
}

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(projectReducer, undefined, initProject);

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
        const buf = await file.arrayBuffer();
        const slice = await loadParquetOcr(buf, state.config);
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
        const buf = await file.arrayBuffer();
        const slice = await loadParquetObjects(buf, state.config);
        dispatch({ type: "set_objects", slice });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        dispatch({ type: "set_error", message: `Objects parquet: ${msg}` });
      }
    },
    [state.config],
  );

  const loadVideoFile = useCallback((file: File) => {
    const url = URL.createObjectURL(file);
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
      frameState: bundle.st,
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
      bundle.st,
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
