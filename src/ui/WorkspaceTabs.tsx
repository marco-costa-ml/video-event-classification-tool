import React, { useEffect, useState } from "react";
import { useProject } from "@/context/ProjectContext";
import { classificationConfigSchema } from "@/schemas";
import {
  exportClassificationJson,
  exportEvaluationReport,
  exportTimelineJson,
  exportEventsAsJsonlForParquetPipeline,
} from "@/services/exportService";
import { tryLoadWasmEngine } from "@/services/engineBridge";

type Tab = "import" | "config" | "zones" | "label" | "eval";

export function WorkspaceTabs() {
  const { state, dispatch, loadSample, loadConfigFile, loadOcrParquet, loadObjectsParquet, loadVideoFile } =
    useProject();
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
            ["zones", "Zones / Pages (JSON)"],
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
            <div className="row">
              <button type="button" onClick={loadSample}>
                Load built-in sample
              </button>
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

        {tab === "zones" ? (
          <div className="muted">
            Zones and pages live inside the classification JSON for this prototype. Use the Event config tab to edit{" "}
            <code>zones</code> and <code>pages</code> arrays. Overlapping zones resolve by highest priority for object
            center assignment (see <code>assignObjectsToZones</code>).
          </div>
        ) : null}

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
