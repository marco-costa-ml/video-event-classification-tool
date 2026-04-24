import { useMemo } from "react";
import { useProject } from "@/context/ProjectContext";

export function InfoPanel() {
  const { state, frameState, predicateStatus } = useProject();
  const preds = useMemo(() => predicateStatus(state.config.events), [state.config.events, predicateStatus]);
  const near = useMemo(() => {
    const out: { frame: number; names: string[] }[] = [];
    for (let d = -3; d <= 3; d++) {
      const f = state.currentFrame + d;
      const fired = state.firedByFrame.get(f);
      if (fired?.length) out.push({ frame: f, names: fired.map((x) => x.eventName) });
    }
    return out;
  }, [state.currentFrame, state.firedByFrame]);

  return (
    <div className="info-panel">
      <div className="muted">Info</div>
      <h3 style={{ marginTop: 8 }}>Frame / time</h3>
      <div>
        Frame: <strong>{frameState.frame}</strong>
      </div>
      <div>
        Time: <strong>{(frameState.timestamp_ms / 1000).toFixed(3)}s</strong>
      </div>
      <div className="muted">Missing data flags (no file loaded)</div>
      <div>OCR file: {frameState.missing.ocr ? "none" : "loaded"}</div>
      <div>Objects file: {frameState.missing.objects ? "none" : "loaded"}</div>
      <h3 style={{ marginTop: 12 }}>Forward-filled state</h3>
      <div className="muted">Sparse key at this frame (exact Parquet row)</div>
      <div>OCR: {frameState.sparse_observation.ocr ? "yes" : "no"}</div>
      <div>Objects: {frameState.sparse_observation.objects ? "yes" : "no"}</div>
      <div className="muted">Counts at this frame</div>
      <div>
        OCR boxes — observed: {frameState.reconstruction_stats.ocr.observed}, carried:{" "}
        {frameState.reconstruction_stats.ocr.carried}
      </div>
      <div>
        Objects — observed: {frameState.reconstruction_stats.objects.observed}, carried:{" "}
        {frameState.reconstruction_stats.objects.carried}, dropped (TTL):{" "}
        {frameState.reconstruction_stats.objects.dropped_ttl}
      </div>

      <h3>Active page</h3>
      <div>{frameState.active_page ? `${frameState.active_page.name} (${frameState.active_page.id})` : "None"}</div>

      <h3>Zones</h3>
      <ul style={{ paddingLeft: 16 }}>
        {Object.entries(frameState.zone_summary).map(([id, z]) => (
          <li key={id}>
            {z.name}: occupancy {z.occupancy}
          </li>
        ))}
      </ul>

      <h3>Objects</h3>
      <ul style={{ paddingLeft: 16 }}>
        {frameState.objects.map((o) => (
          <li key={`${o.id}-${frameState.frame}`}>
            ({o.id}){o.className ? ` class_ID: [${o.className}]` : ""}{" "}
            {o.provenance ? `[${o.provenance}]` : ""} score{" "}
            {o.score != null ? o.score.toFixed(2) : "n/a"} zone{" "}
            {frameState.object_primary_zone[o.id]?.zoneName ?? "—"}
          </li>
        ))}
      </ul>

      <h3>OCR summary</h3>
      <ul style={{ paddingLeft: 16 }}>
        {Object.entries(frameState.ocr_by_label).map(([label, boxes]) => {
          const prov = boxes[0]?.provenance;
          return (
            <li key={label}>
              {label} {prov ? `(${prov})` : ""}: {boxes.map((b) => b.text).join(", ")}
            </li>
          );
        })}
      </ul>

      <h3>Predicates (events)</h3>
      <ul style={{ paddingLeft: 16 }}>
        {preds.map((p) => (
          <li key={p.id}>
            {p.name}: {p.satisfied ? "satisfied" : "not satisfied"}
          </li>
        ))}
      </ul>

      <h3>Firings near frame</h3>
      {near.length === 0 ? <div className="muted">None in ±3 frames</div> : null}
      <ul style={{ paddingLeft: 16 }}>
        {near.map((n) => (
          <li key={n.frame}>
            f={n.frame}: {n.names.join(", ")}
          </li>
        ))}
      </ul>
    </div>
  );
}
