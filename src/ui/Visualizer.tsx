import React, { useEffect, useRef, useState } from "react";
import { useProject } from "@/context/ProjectContext";
import type { ZoneDefinition } from "@/schemas";

function drawZone(
  ctx: CanvasRenderingContext2D,
  z: ZoneDefinition,
  sx: number,
  sy: number,
  color: string,
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  if (z.geometry.type === "rectangle") {
    const g = z.geometry;
    ctx.strokeRect(g.x * sx, g.y * sy, g.width * sx, g.height * sy);
    ctx.fillStyle = "rgba(76,141,255,0.08)";
    ctx.fillRect(g.x * sx, g.y * sy, g.width * sx, g.height * sy);
  } else {
    ctx.beginPath();
    const pts = z.geometry.points;
    if (pts.length) {
      ctx.moveTo(pts[0]!.x * sx, pts[0]!.y * sy);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x * sx, pts[i]!.y * sy);
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function Visualizer() {
  const { state, dispatch, frameState } = useProject();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const frameRef = useRef(state.currentFrame);

  const vw = state.config.video.width;
  const vh = state.config.video.height;

  useEffect(() => {
    frameRef.current = state.currentFrame;
  }, [state.currentFrame]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !state.videoUrl) return;
    const t = frameState.frame / state.config.video.fps;
    if (Number.isFinite(t)) {
      const delta = Math.abs(v.currentTime - t);
      if (delta > 0.001) v.currentTime = t;
    }
  }, [frameState.frame, state.config.video.fps, state.videoUrl]);

  useEffect(() => {
    if (!playing) return;
    const maxF = Math.max(0, state.config.video.frame_count - 1);
    const id = window.setInterval(() => {
      const cur = frameRef.current;
      if (cur >= maxF) {
        setPlaying(false);
        return;
      }
      dispatch({ type: "set_frame", frame: cur + 1 });
    }, 1000 / state.config.video.fps);
    return () => window.clearInterval(id);
  }, [playing, state.config.video.fps, state.config.video.frame_count, dispatch]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(r.width));
      canvas.height = Math.max(1, Math.floor(r.height));
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!state.videoUrl) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const sx = canvas.width / vw;
    const sy = canvas.height / vh;

    if (state.layers.zones) {
      for (const z of state.config.zones) drawZone(ctx, z, sx, sy, "#4c8dff");
    }
    if (state.layers.objects) {
      for (const o of frameState.objects) {
        ctx.strokeStyle = "#12b76a";
        ctx.lineWidth = 2;
        ctx.strokeRect(o.x * sx, o.y * sy, o.w * sx, o.h * sy);
      }
    }
    if (state.layers.ocr) {
      ctx.font = `${Math.max(12, 14 * sx)}px sans-serif`;
      for (const b of frameState.ocr_boxes) {
        ctx.fillStyle = "rgba(79,110,247,0.9)";
        ctx.fillText(`${b.label}: ${b.text}`, b.x * sx, b.y * sy);
      }
    }
    if (state.layers.predictions) {
      for (const e of state.predicted) {
        if (e.kind !== "point") continue;
        if (e.start_frame !== frameState.frame) continue;
        ctx.fillStyle = "rgba(245,158,11,0.9)";
        ctx.fillRect(12, canvas.height - 28, 200, 18);
        ctx.fillStyle = "#111";
        ctx.fillText(`pred: ${e.event_name}`, 18, canvas.height - 14);
      }
    }
    if (state.layers.groundTruth) {
      for (const e of state.manualLabels) {
        if (e.kind !== "point") continue;
        if (e.start_frame !== frameState.frame) continue;
        ctx.fillStyle = "rgba(236,72,153,0.95)";
        ctx.fillRect(canvas.width - 220, canvas.height - 28, 200, 18);
        ctx.fillStyle = "#111";
        ctx.fillText(`GT: ${e.event_name}`, canvas.width - 210, canvas.height - 14);
      }
    }
  }, [frameState, state.config.zones, state.layers, state.manualLabels, state.predicted, state.videoUrl, vw, vh]);

  const maxF = Math.max(0, state.config.video.frame_count - 1);

  return (
    <div className="visualizer">
      <div ref={wrapRef} className="canvas-wrap">
        {state.videoUrl ? (
          <video ref={videoRef} src={state.videoUrl} controls={false} muted playsInline />
        ) : null}
        <canvas ref={canvasRef} />
      </div>
      <div className="controls">
        <button type="button" onClick={() => setPlaying((p) => !p)}>
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" onClick={() => dispatch({ type: "set_frame", frame: state.currentFrame - 1 })}>
          ◀︎ Frame
        </button>
        <button type="button" onClick={() => dispatch({ type: "set_frame", frame: state.currentFrame + 1 })}>
          Frame ▶︎
        </button>
        <button
          type="button"
          onClick={() => {
            const keys = [...state.firedByFrame.keys()].sort((a, b) => a - b);
            const next = keys.find((f) => f > state.currentFrame);
            if (next !== undefined) dispatch({ type: "set_frame", frame: next });
          }}
        >
          Next firing
        </button>
        <button
          type="button"
          onClick={() => {
            const keys = [...state.firedByFrame.keys()].sort((a, b) => b - a);
            const prev = keys.find((f) => f < state.currentFrame);
            if (prev !== undefined) dispatch({ type: "set_frame", frame: prev });
          }}
        >
          Prev firing
        </button>
        <label className="row">
          <span className="muted">Scrub</span>
          <input
            type="range"
            min={0}
            max={maxF}
            value={state.currentFrame}
            onChange={(e) => dispatch({ type: "set_frame", frame: Number(e.target.value) })}
          />
        </label>
        <span className="muted">
          {state.currentFrame}/{maxF}
        </span>
        <div className="row" style={{ marginLeft: "auto" }}>
          {(
            [
              ["ocr", "OCR"],
              ["objects", "Objects"],
              ["zones", "Zones"],
              ["pages", "Pages"],
              ["labels", "Labels"],
              ["predictions", "Pred"],
              ["groundTruth", "GT"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="row">
              <input
                type="checkbox"
                checked={state.layers[k]}
                onChange={() => dispatch({ type: "toggle_layer", key: k })}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
