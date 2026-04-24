import { useEffect, useRef, useState } from "react";
import { useProject } from "@/context/ProjectContext";
import { classificationConfigSchema } from "@/schemas";
import { timelineEventSchema } from "@/schemas/labels";
import {
  exportClassificationJson,
  exportEvaluationReport,
  exportTimelineJson,
  exportEventsAsJsonlForParquetPipeline,
  exportEnrichedJson,
} from "@/services/exportService";
import { tryLoadWasmEngine } from "@/services/engineBridge";
import { ZonesPagesEditor } from "@/ui/ZonesPagesEditor";
import { EventBuilderEditor } from "@/ui/EventBuilderEditor";

type Tab = "import" | "config" | "zones" | "events" | "label" | "eval";

export function WorkspaceTabs() {
  const {
    state,
    dispatch,
    loadConfigFile,
    loadOcrParquet,
    loadObjectsParquet,
    loadVideoFile,
    loadOcrLayoutFile,
    loadBuiltinOcrLayout,
    stateAt,
  } = useProject();
  const importLabelsRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>("import");
  const [cfgText, setCfgText] = useState(() => JSON.stringify(state.config, null, 2));
  const [labelName, setLabelName] = useState("person_in_roi");
  const [rangeEnd, setRangeEnd] = useState<number | "">("");
  const [wasmStatus, setWasmStatus] = useState<string>("checking…");

  useEffect(() => {
    void tryLoadWasmEngine().then((m) => setWasmStatus(m ? `wasm: ${m.version()}` : "wasm: not built (JS engine)"));
  }, []);

  useEffect(() => {
    if (tab === "config") setCfgText(JSON.stringify(state.config, null, 2));
  }, [tab, state.config, state.revision]);

  const applyConfigText = () => {
    try {
      const json = JSON.parse(cfgText) as unknown;
      const cfg = classificationConfigSchema.parse(json);
      dispatch({ type: "set_error", message: null });
      dispatch({ type: "update_config", config: cfg });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      dispatch({ type: "set_error", message: `Config editor: ${msg}` });
    }
  };

  return (
    <div className="bottom-pane">
      <div className="tabs">
        {(
          [
            ["import", "Import / Export"],
            ["config", "Event config (JSON)"],
            ["zones", "Zones / Pages"],
            ["events", "Event Builder"],
            ["label", "Manual labeling"],
            ["eval", "Evaluation"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" className={`tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="tab-panel">
        {state.lastError ? <div className="error">{state.lastError}</div> : null}
        <div className="muted">{wasmStatus}</div>

        {tab === "import" ? (
          <div className="row" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
            <div className="muted">
              Large uploads are automatically clipped to the first 10 minutes to keep interaction responsive.
            </div>
            <div className="row" style={{ alignItems: "center", gap: 16 }}>
              <strong style={{ fontSize: 13 }}>Reconstruction</strong>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                Object carry TTL (frames)
                <input
                  type="number"
                  min={0}
                  style={{ width: 64 }}
                  value={state.config.reconstruction?.object_ttl_frames ?? 2}
                  onChange={(e) => {
                    const val = Math.max(0, Math.floor(Number(e.target.value)));
                    dispatch({
                      type: "update_config",
                      config: {
                        ...state.config,
                        reconstruction: { ...state.config.reconstruction, object_ttl_frames: val },
                      },
                    });
                  }}
                />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                OCR forward-fill TTL (frames)
                <input
                  type="number"
                  min={0}
                  style={{ width: 64 }}
                  value={state.config.reconstruction?.ocr_ttl_frames ?? 5}
                  onChange={(e) => {
                    const val = Math.max(0, Math.floor(Number(e.target.value)));
                    dispatch({
                      type: "update_config",
                      config: {
                        ...state.config,
                        reconstruction: { ...state.config.reconstruction, ocr_ttl_frames: val },
                      },
                    });
                  }}
                />
              </label>
            </div>
            <div className="row">
              <button
                type="button"
                onClick={() => importLabelsRef.current?.click()}
              >
                Import manual labels
              </button>
              <input
                ref={importLabelsRef}
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  e.target.value = "";
                  file.text().then((text) => {
                    try {
                      const raw = JSON.parse(text) as unknown;
                      // Accept plain array OR { events: [...] } wrapper
                      const arr = Array.isArray(raw) ? raw : Array.isArray((raw as { events?: unknown }).events) ? (raw as { events: unknown[] }).events : null;
                      if (!arr) { dispatch({ type: "set_error", message: "Import failed: expected an array or { events: [...] }" }); return; }
                      let imported = 0;
                      for (const item of arr) {
                        const parsed = timelineEventSchema.safeParse(item);
                        if (!parsed.success) continue;
                        dispatch({ type: "add_manual_label", label: { ...parsed.data, source: "manual" } });
                        imported++;
                      }
                      if (imported === 0) dispatch({ type: "set_error", message: "Import: no valid label entries found in file." });
                    } catch {
                      dispatch({ type: "set_error", message: "Import failed: file is not valid JSON." });
                    }
                  }).catch(() => dispatch({ type: "set_error", message: "Import failed: could not read file." }));
                }}
              />
              <button type="button" onClick={() => dispatch({ type: "run_detection" })}>
                Re-run detection
              </button>
              <button type="button" onClick={() => dispatch({ type: "set_error", message: null })}>
                Clear error
              </button>
            </div>
            <label className="row">
              Classification JSON
              <input type="file" accept="application/json,.json" onChange={(e) => e.target.files?.[0] && void loadConfigFile(e.target.files[0])} />
            </label>
            <label className="row">
              OCR parquet
              <input type="file" accept=".parquet" onChange={(e) => e.target.files?.[0] && void loadOcrParquet(e.target.files[0])} />
            </label>
            <label className="row">
              Objects parquet
              <input type="file" accept=".parquet" onChange={(e) => e.target.files?.[0] && void loadObjectsParquet(e.target.files[0])} />
            </label>
            <label className="row">
              Optional video
              <input type="file" accept="video/*" onChange={(e) => e.target.files?.[0] && loadVideoFile(e.target.files[0])} />
            </label>
            <div className="row" style={{ alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13 }}>OCR layout</span>
              <button type="button" onClick={loadBuiltinOcrLayout}>
                Load built-in layout
              </button>
              <label className="row" style={{ cursor: "pointer" }}>
                Import layout JSON
                <input
                  type="file"
                  accept="application/json,.json"
                  style={{ display: "none" }}
                  onChange={(e) => e.target.files?.[0] && void loadOcrLayoutFile(e.target.files[0])}
                />
              </label>
              {state.ocrLayout ? (
                <span className="muted">{Object.keys(state.ocrLayout).length} labels loaded</span>
              ) : (
                <span className="muted">none loaded</span>
              )}
              {state.ocrLayout ? (
                <button type="button" onClick={() => dispatch({ type: "set_ocr_layout", layout: null })}>
                  Clear layout
                </button>
              ) : null}
            </div>
            <div className="row">
              <button type="button" onClick={() => exportClassificationJson(state.config)}>
                Export classification JSON
              </button>
              <button type="button" onClick={() => exportTimelineJson(state.predicted, "predicted_events.json")}>
                Export predicted JSON
              </button>
              <button type="button" onClick={() => exportTimelineJson(state.manualLabels, "ground_truth.json")}>
                Export manual labels JSON
              </button>
              <button type="button" onClick={() => exportEventsAsJsonlForParquetPipeline(state.predicted)}>
                Export predicted JSONL (parquet pipeline)
              </button>
              {state.evaluation ? (
                <button type="button" onClick={() => exportEvaluationReport(state.evaluation!)}>
                  Export evaluation JSON
                </button>
              ) : null}
            </div>
            <div className="row">
              <button
                type="button"
                onClick={() =>
                  exportEnrichedJson(
                    state.predicted,
                    state.config,
                    stateAt,
                    `${state.config.video.video_id}_enriched.json`,
                  )
                }
                disabled={!state.predicted.length}
                title="Export predicted events enriched with zone objects and OCR values at each event frame"
              >
                Export enriched events JSON
              </button>
              <button
                type="button"
                onClick={() =>
                  exportEnrichedJson(
                    state.manualLabels,
                    state.config,
                    stateAt,
                    `${state.config.video.video_id}_enriched_gt.json`,
                  )
                }
                disabled={!state.manualLabels.length}
                title="Export manual labels enriched with zone objects and OCR values at each label frame"
              >
                Export enriched ground-truth JSON
              </button>
            </div>
          </div>
        ) : null}

        {tab === "config" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
            <div className="muted">
              Edit the full classification config (events, predicates, pages, zones). Validate with Zod on apply.
            </div>
            <textarea
              style={{ width: "100%", height: "55vh", background: "#0b0d12", color: "#e8eaed", border: "1px solid #2a2f3a" }}
              value={cfgText}
              onChange={(e) => setCfgText(e.target.value)}
            />
            <div className="row">
              <button type="button" onClick={() => setCfgText(JSON.stringify(state.config, null, 2))}>
                Reset from live state
              </button>
              <button type="button" onClick={applyConfigText}>
                Apply + re-run detection
              </button>
            </div>
          </div>
        ) : null}

        {tab === "zones" ? <ZonesPagesEditor /> : null}
        {tab === "events" ? <EventBuilderEditor /> : null}

        {tab === "label" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 720 }}>
            <div className="row">
              <label>
                Event name{" "}
                <input value={labelName} onChange={(e) => setLabelName(e.target.value)} />
              </label>
              <button
                type="button"
                onClick={() =>
                  dispatch({
                    type: "add_manual_label",
                    label: {
                      id: `gt_${Date.now()}`,
                      kind: "point",
                      event_name: labelName,
                      start_frame: state.currentFrame,
                      source: "manual",
                    },
                  })
                }
              >
                Mark point @ current frame (shortcut: M)
              </button>
            </div>
            <div className="row">
              <label>
                Range end frame (optional){" "}
                <input
                  type="number"
                  value={rangeEnd}
                  onChange={(e) => setRangeEnd(e.target.value === "" ? "" : Number(e.target.value))}
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  const end = typeof rangeEnd === "number" ? rangeEnd : state.currentFrame;
                  const s = Math.min(state.currentFrame, end);
                  const e = Math.max(state.currentFrame, end);
                  dispatch({
                    type: "add_manual_label",
                    label: {
                      id: `gt_${Date.now()}`,
                      kind: "range",
                      event_name: labelName,
                      start_frame: s,
                      end_frame: e,
                      source: "manual",
                    },
                  });
                }}
              >
                Mark range
              </button>
            </div>
            <div className="muted">Keyboard: press “m” while the visualizer is focused to add a point label quickly.</div>
            <table className="table">
              <thead>
                <tr>
                  <th>id</th>
                  <th>name</th>
                  <th>kind</th>
                  <th>start</th>
                  <th>end</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {state.manualLabels.map((l) => (
                  <tr key={l.id}>
                    <td>{l.id}</td>
                    <td>{l.event_name}</td>
                    <td>{l.kind}</td>
                    <td>{l.start_frame}</td>
                    <td>{l.end_frame ?? ""}</td>
                    <td>
                      <button type="button" onClick={() => dispatch({ type: "delete_manual_label", id: l.id })}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {tab === "eval" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="row">
              <label>
                Tolerance (frames){" "}
                <input
                  type="number"
                  value={state.evalTolerance}
                  onChange={(e) => dispatch({ type: "set_eval_tolerance", tolerance: Number(e.target.value) })}
                />
              </label>
              <button type="button" onClick={() => dispatch({ type: "run_evaluation" })}>
                Run evaluation
              </button>
            </div>
            {state.evaluation ? (
              <div>
                <h4>Overall</h4>
                <table className="table">
                  <tbody>
                    <tr>
                      <th>manual</th>
                      <td>{state.evaluation.overall.manual_count}</td>
                    </tr>
                    <tr>
                      <th>predicted</th>
                      <td>{state.evaluation.overall.predicted_count}</td>
                    </tr>
                    <tr>
                      <th>matched</th>
                      <td>{state.evaluation.overall.matched}</td>
                    </tr>
                    <tr>
                      <th>FP</th>
                      <td>{state.evaluation.overall.false_positives}</td>
                    </tr>
                    <tr>
                      <th>FN</th>
                      <td>{state.evaluation.overall.false_negatives}</td>
                    </tr>
                    <tr>
                      <th>P / R / F1</th>
                      <td>
                        {state.evaluation.overall.precision.toFixed(3)} / {state.evaluation.overall.recall.toFixed(3)} /{" "}
                        {state.evaluation.overall.f1.toFixed(3)}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <h4>Per event type</h4>
                <table className="table">
                  <thead>
                    <tr>
                      <th>name</th>
                      <th>manual</th>
                      <th>pred</th>
                      <th>|Δ|</th>
                      <th>matched</th>
                      <th>FP</th>
                      <th>FN</th>
                      <th>F1</th>
                      <th>avg err</th>
                      <th>median err</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.evaluation.per_type.map((r) => (
                      <tr key={r.event_name}>
                        <td>{r.event_name}</td>
                        <td>{r.manual_count}</td>
                        <td>{r.predicted_count}</td>
                        <td>{r.count_abs_diff}</td>
                        <td>{r.matched}</td>
                        <td>{r.false_positives}</td>
                        <td>{r.false_negatives}</td>
                        <td>{r.f1.toFixed(3)}</td>
                        <td>{r.avg_temporal_error_frames?.toFixed(2) ?? "—"}</td>
                        <td>{r.median_temporal_error_frames?.toFixed(2) ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="muted">Run evaluation after labeling to compare against predicted events.</div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
