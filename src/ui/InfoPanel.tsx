import React, { useMemo } from "react";
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
      <div className="muted">Missing data flags</div>
      <div>OCR sparse gap: {frameState.missing.ocr ? "no rows" : "rows present"}</div>
      <div>Objects sparse gap: {frameState.missing.objects ? "no rows" : "rows present"}</div>

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
            {o.className} ({o.id}) score {o.score ?? "n/a"} zone{" "}
            {frameState.object_primary_zone[o.id]?.zoneName ?? "—"}
          </li>
        ))}
      </ul>

      <h3>OCR summary</h3>
      <ul style={{ paddingLeft: 16 }}>
        {Object.entries(frameState.ocr_by_label).map(([label, boxes]) => (
          <li key={label}>
            {label}: {boxes.map((b) => b.text).join(", ")}
          </li>
        ))}
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
