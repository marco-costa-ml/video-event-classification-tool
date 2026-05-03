import { useCallback, useEffect, useMemo, useState } from "react";
import { useProject } from "@/context/ProjectContext";
import {
  classificationConfigSchema,
  type ClassificationConfig,
  type ObjectClassRange,
  type PageDefinition,
  type ZoneDefinition,
} from "@/schemas";
import { predicateNodeSchema, type PredicateNode } from "@/schemas/predicates";
import { evaluatePredicate, type EvalContext } from "@/domain/predicateEval";

// ─── Shared helpers ─────────────────────────────────────────────────────────────

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function splitCommaList(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function rangeSummary(ranges: ObjectClassRange[] | undefined): string {
  if (!ranges?.length) return "—";
  return ranges.map((r) => (r.min === r.max ? String(r.min) : `${r.min}–${r.max}`)).join(", ");
}

function eventsReferencingZoneId(config: ClassificationConfig, zoneId: string): string[] {
  const out: string[] = [];
  const s = JSON.stringify(config.events);
  if (!s.includes(zoneId)) return out;
  for (const ev of config.events) {
    if (JSON.stringify(ev).includes(zoneId)) out.push(ev.name || ev.id);
  }
  return out;
}

// ─── Page condition model ────────────────────────────────────────────────────────

type PageCondKind =
  | "ocr_contains"
  | "ocr_equals"
  | "ocr_not_empty"
  | "class_count"
  | "zone_occupancy"
  | "zone_physical_occupancy";

type CountOp = ">=" | ">" | "==" | "!=";

type PageCond = {
  id: string;
  kind: PageCondKind;
  // ocr conditions
  ocrLabel: string;
  ocrText: string;
  // class count
  className: string;
  countOp: CountOp;
  countValue: number;
  // zone occupancy
  zoneId: string;
  zoneOp: CountOp;
  zoneValue: number;
};

type PageBuilder = {
  logicalOp: "and" | "or";
  conditions: PageCond[];
};

function defaultCond(cfg: ClassificationConfig): PageCond {
  return {
    id: newId("cond"),
    kind: "ocr_contains",
    ocrLabel: "title",
    ocrText: "",
    className: "",
    countOp: ">=",
    countValue: 1,
    zoneId: cfg.zones[0]?.id ?? "",
    zoneOp: ">",
    zoneValue: 0,
  };
}

function defaultBuilder(): PageBuilder {
  return { logicalOp: "and", conditions: [] };
}

// ─── Predicate ↔ builder ─────────────────────────────────────────────────────────

function condToPredicate(c: PageCond): PredicateNode {
  if (c.kind === "ocr_contains") {
    return {
      kind: "comparison",
      left: { kind: "field", path: ["ocr", "by_label", c.ocrLabel, 0, "text"] },
      op: "contains",
      right: { kind: "literal", value: c.ocrText },
    };
  }
  if (c.kind === "ocr_equals") {
    return {
      kind: "comparison",
      left: { kind: "field", path: ["ocr", "by_label", c.ocrLabel, 0, "text"] },
      op: "==",
      right: { kind: "literal", value: c.ocrText },
    };
  }
  if (c.kind === "ocr_not_empty") {
    return { kind: "exists", path: ["ocr", "by_label", c.ocrLabel, 0, "text"] };
  }
  if (c.kind === "class_count") {
    return {
      kind: "comparison",
      left: { kind: "field", path: ["class_counts", c.className] },
      op: c.countOp,
      right: { kind: "literal", value: c.countValue },
    };
  }
  // zone occupancy
  const zonePathRoot = c.kind === "zone_physical_occupancy" ? "zone_membership" : "zones";
  return {
    kind: "comparison",
    left: { kind: "field", path: [zonePathRoot, c.zoneId, "occupancy"] },
    op: c.zoneOp,
    right: { kind: "literal", value: c.zoneValue },
  };
}

function builderToPredicate(b: PageBuilder): PredicateNode {
  if (b.conditions.length === 0) {
    return { kind: "logical", op: "and", children: [] };
  }
  const children = b.conditions.map(condToPredicate);
  if (children.length === 1) return children[0]!;
  return { kind: "logical", op: b.logicalOp, children };
}

function tryParseCondition(node: PredicateNode, cfg: ClassificationConfig): PageCond | null {
  const base = defaultCond(cfg);
  if (node.kind === "exists") {
    const p = node.path;
    if (p[0] === "ocr" && p[1] === "by_label" && p.length >= 3) {
      return { ...base, id: newId("cond"), kind: "ocr_not_empty", ocrLabel: String(p[2] ?? "") };
    }
  }
  if (node.kind === "comparison" && node.left.kind === "field" && node.right.kind === "literal") {
    const path = node.left.path;
    const op = node.op;
    const val = node.right.value;
    // OCR text
    if (
      path[0] === "ocr" && path[1] === "by_label" && path[3] === 0 && path[4] === "text"
    ) {
      const label = String(path[2] ?? "");
      const text = String(val ?? "");
      if (op === "contains") return { ...base, id: newId("cond"), kind: "ocr_contains", ocrLabel: label, ocrText: text };
      if (op === "==")       return { ...base, id: newId("cond"), kind: "ocr_equals",   ocrLabel: label, ocrText: text };
    }
    // class count
    if (path[0] === "class_counts" && path.length === 2) {
      const cls = String(path[1] ?? "");
      if (op === ">=" || op === ">" || op === "==" || op === "!=") {
        return { ...base, id: newId("cond"), kind: "class_count", className: cls, countOp: op, countValue: Number(val) };
      }
    }
    // zone occupancy
    if (path[0] === "zones" && path.length === 3 && path[2] === "occupancy") {
      const zid = String(path[1] ?? "");
      if (op === ">=" || op === ">" || op === "==" || op === "!=") {
        return { ...base, id: newId("cond"), kind: "zone_occupancy", zoneId: zid, zoneOp: op, zoneValue: Number(val) };
      }
    }
    if (path[0] === "zone_membership" && path.length === 3 && path[2] === "occupancy") {
      const zid = String(path[1] ?? "");
      if (op === ">=" || op === ">" || op === "==" || op === "!=") {
        return { ...base, id: newId("cond"), kind: "zone_physical_occupancy", zoneId: zid, zoneOp: op, zoneValue: Number(val) };
      }
    }
  }
  return null;
}

function tryParsePredicate(pred: PredicateNode, cfg: ClassificationConfig): PageBuilder | null {
  // empty logical
  if (pred.kind === "logical" && pred.children.length === 0) {
    return { logicalOp: "and", conditions: [] };
  }
  // single condition
  const single = tryParseCondition(pred, cfg);
  if (single) return { logicalOp: "and", conditions: [single] };
  // logical and/or of known conditions
  if (pred.kind === "logical" && (pred.op === "and" || pred.op === "or")) {
    const conds = pred.children.map((c) => tryParseCondition(c, cfg));
    if (conds.every((c): c is PageCond => c !== null)) {
      return { logicalOp: pred.op, conditions: conds };
    }
  }
  return null; // too complex
}

// ─── Condition card ───────────────────────────────────────────────────────────────

const COUNT_OPS: { value: CountOp; label: string }[] = [
  { value: ">=", label: "≥" },
  { value: ">",  label: ">" },
  { value: "==", label: "=" },
  { value: "!=", label: "≠" },
];

type CondCardProps = {
  cond: PageCond;
  index: number;
  cfg: ClassificationConfig;
  knownOcrLabels: string[];
  onChange: (patch: Partial<PageCond>) => void;
  onRemove: () => void;
};

function CondCard({ cond, index, cfg, knownOcrLabels, onChange, onRemove }: CondCardProps) {
  const kindColor: Record<PageCondKind, string> = {
    ocr_contains:  "#4c8dff",
    ocr_equals:    "#4c8dff",
    ocr_not_empty: "#4c8dff",
    class_count:   "#12b76a",
    zone_occupancy:"#f59e0b",
    zone_physical_occupancy:"#f59e0b",
  };

  return (
    <div style={{
      border: `1px solid #2a2f3a`,
      borderLeft: `3px solid ${kindColor[cond.kind]}`,
      borderRadius: 6,
      padding: "10px 12px",
      background: "#0f1318",
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#9aa3b2", letterSpacing: "0.04em" }}>
          CONDITION {index + 1}
        </span>
        <button type="button" onClick={onRemove} style={{ fontSize: 11, padding: "2px 8px" }}>
          Remove
        </button>
      </div>

      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <label style={{ fontSize: 13 }}>
          Type{" "}
          <select value={cond.kind} onChange={(e) => onChange({ kind: e.target.value as PageCondKind })}>
            <option value="ocr_contains">OCR text contains phrase</option>
            <option value="ocr_equals">OCR text exactly equals</option>
            <option value="ocr_not_empty">OCR label is present (not empty)</option>
            <option value="class_count">Object class count</option>
            <option value="zone_occupancy">Zone occupancy (exclusive)</option>
            <option value="zone_physical_occupancy">Zone occupancy (physical)</option>
          </select>
        </label>
      </div>

      {/* OCR conditions */}
      {(cond.kind === "ocr_contains" || cond.kind === "ocr_equals" || cond.kind === "ocr_not_empty") ? (
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 13 }}>
            OCR label{" "}
            {knownOcrLabels.length > 0 ? (
              <select
                value={cond.ocrLabel}
                onChange={(e) => onChange({ ocrLabel: e.target.value })}
              >
                {knownOcrLabels.map((l) => <option key={l} value={l}>{l}</option>)}
                {!knownOcrLabels.includes(cond.ocrLabel) && cond.ocrLabel ? (
                  <option value={cond.ocrLabel}>{cond.ocrLabel} (custom)</option>
                ) : null}
              </select>
            ) : (
              <input
                value={cond.ocrLabel}
                placeholder="e.g. title"
                onChange={(e) => onChange({ ocrLabel: e.target.value })}
              />
            )}
          </label>
          {cond.kind !== "ocr_not_empty" ? (
            <label style={{ fontSize: 13 }}>
              {cond.kind === "ocr_contains" ? "Contains" : "Exactly"}
              {" "}
              <input
                value={cond.ocrText}
                placeholder={cond.kind === "ocr_contains" ? "e.g. Home" : "exact value"}
                onChange={(e) => onChange({ ocrText: e.target.value })}
              />
            </label>
          ) : null}
          {cond.kind === "ocr_not_empty" ? (
            <span className="muted" style={{ fontSize: 12 }}>
              Passes when the label has any text at this frame
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Class count */}
      {cond.kind === "class_count" ? (
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 13 }}>
            Class name / ID{" "}
            <input
              value={cond.className}
              placeholder="e.g. 51 or person"
              onChange={(e) => onChange({ className: e.target.value })}
            />
          </label>
          <label style={{ fontSize: 13 }}>
            Count{" "}
            <select
              value={cond.countOp}
              onChange={(e) => onChange({ countOp: e.target.value as CountOp })}
              style={{ width: 52 }}
            >
              {COUNT_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <input
            type="number"
            style={{ width: 64 }}
            value={cond.countValue}
            min={0}
            onChange={(e) => onChange({ countValue: Number(e.target.value) })}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            objects of that class in frame
          </span>
        </div>
      ) : null}

      {/* Zone occupancy */}
      {(cond.kind === "zone_occupancy" || cond.kind === "zone_physical_occupancy") ? (
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 13 }}>
            Zone{" "}
            <select value={cond.zoneId} onChange={(e) => onChange({ zoneId: e.target.value })}>
              {cfg.zones.length === 0
                ? <option value="">No zones defined yet</option>
                : cfg.zones.map((z) => (
                    <option key={z.id} value={z.id}>{z.name}</option>
                  ))}
            </select>
          </label>
          <label style={{ fontSize: 13 }}>
            Occupancy{" "}
            <select
              value={cond.zoneOp}
              onChange={(e) => onChange({ zoneOp: e.target.value as CountOp })}
              style={{ width: 52 }}
            >
              {COUNT_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <input
            type="number"
            style={{ width: 64 }}
            value={cond.zoneValue}
            min={0}
            onChange={(e) => onChange({ zoneValue: Number(e.target.value) })}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            {cond.kind === "zone_physical_occupancy" ? "objects physically inside zone, ignoring priority" : "objects assigned to this zone after priority rules"}
          </span>
        </div>
      ) : null}
    </div>
  );
}

// ─── Page editor ──────────────────────────────────────────────────────────────────

type PageEditorProps = {
  page: PageDefinition;
  cfg: ClassificationConfig;
  currentFrame: number;
  frameOcrLabels: string[];
  isMatch: boolean | null;
  onSave: (match: PredicateNode, name: string, priority: number) => void;
  onDelete: () => void;
};

function PageEditor({ page, cfg, currentFrame, frameOcrLabels, isMatch, onSave, onDelete }: PageEditorProps) {
  const [name, setName] = useState(page.name);
  const [priority, setPriority] = useState(page.priority);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [jsonText, setJsonText] = useState(() => JSON.stringify(page.match, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);

  const parsed = useMemo(() => tryParsePredicate(page.match, cfg), [page.match, cfg]);
  const [builder, setBuilder] = useState<PageBuilder>(() => parsed ?? defaultBuilder());
  const tooComplex = parsed === null;

  // Re-sync when page changes
  useEffect(() => {
    setName(page.name);
    setPriority(page.priority);
    setJsonText(JSON.stringify(page.match, null, 2));
    setJsonError(null);
    const p = tryParsePredicate(page.match, cfg);
    setBuilder(p ?? defaultBuilder());
    if (p === null) setShowAdvanced(true);
  }, [page.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateCond = (i: number, patch: Partial<PageCond>) => {
    setBuilder((b) => ({
      ...b,
      conditions: b.conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)),
    }));
  };

  const removeCond = (i: number) => {
    setBuilder((b) => ({ ...b, conditions: b.conditions.filter((_, idx) => idx !== i) }));
  };

  const addCond = () => {
    setBuilder((b) => ({ ...b, conditions: [...b.conditions, defaultCond(cfg)] }));
  };

  const handleSaveBuilder = () => {
    const match = builderToPredicate(builder);
    onSave(match, name.trim() || page.name, priority);
  };

  const handleSaveJson = () => {
    try {
      const parsed2 = predicateNodeSchema.parse(JSON.parse(jsonText) as unknown);
      setJsonError(null);
      onSave(parsed2, name.trim() || page.name, priority);
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : String(e));
    }
  };

  const syncBuilderToJson = () => {
    setJsonText(JSON.stringify(builderToPredicate(builder), null, 2));
  };

  const matchBadge = isMatch === null
    ? { label: "—", color: "#6b7385", bg: "transparent" }
    : isMatch
      ? { label: "MATCH", color: "#12b76a", bg: "rgba(18,183,106,0.12)" }
      : { label: "no match", color: "#9aa3b2", bg: "transparent" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Header: name, priority, match badge */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <label style={{ fontSize: 13 }}>
          Page name{" "}
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ minWidth: 160 }} />
        </label>
        <label style={{ fontSize: 13 }}>
          Priority{" "}
          <input
            type="number"
            style={{ width: 70 }}
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
          />
          <span className="muted" style={{ marginLeft: 4, fontSize: 11 }}>higher wins</span>
        </label>
        <div style={{
          marginLeft: "auto",
          padding: "4px 12px",
          borderRadius: 20,
          background: matchBadge.bg,
          border: `1px solid ${matchBadge.color}`,
          fontSize: 12,
          fontWeight: 600,
          color: matchBadge.color,
          letterSpacing: "0.04em",
        }}>
          Frame {currentFrame}: {matchBadge.label}
        </div>
        <button type="button" onClick={onDelete} style={{ fontSize: 12, padding: "4px 10px", marginLeft: 4 }}>
          Delete page
        </button>
      </div>

      {/* Advanced toggle */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          onClick={() => {
            if (!showAdvanced) syncBuilderToJson();
            setShowAdvanced((v) => !v);
            setJsonError(null);
          }}
          style={{ fontSize: 12, padding: "3px 10px" }}
        >
          {showAdvanced ? "◀ Visual builder" : "Advanced (JSON) ▶"}
        </button>
        {tooComplex && !showAdvanced ? (
          <span style={{ fontSize: 12, color: "#f59e0b" }}>
            ⚠ Predicate is too complex to display visually — use Advanced mode
          </span>
        ) : null}
        <span className="muted" style={{ fontSize: 11 }}>
          ID: <code>{page.id}</code>
        </span>
      </div>

      {/* ── Visual builder ── */}
      {!showAdvanced ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Logical operator */}
          {builder.conditions.length > 1 ? (
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              background: "rgba(76,141,255,0.07)",
              border: "1px solid rgba(76,141,255,0.2)",
              borderRadius: 6,
            }}>
              <span style={{ fontSize: 13, color: "#c8d0e0" }}>This page matches when</span>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input
                  type="radio"
                  checked={builder.logicalOp === "and"}
                  onChange={() => setBuilder((b) => ({ ...b, logicalOp: "and" }))}
                />
                <strong>ALL</strong> conditions are met
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input
                  type="radio"
                  checked={builder.logicalOp === "or"}
                  onChange={() => setBuilder((b) => ({ ...b, logicalOp: "or" }))}
                />
                <strong>ANY</strong> condition is met
              </label>
            </div>
          ) : null}

          {builder.conditions.length === 0 ? (
            <div style={{
              padding: "20px",
              textAlign: "center",
              border: "1px dashed #2a2f3a",
              borderRadius: 6,
              color: "#6b7385",
              fontSize: 13,
            }}>
              No conditions yet — page will never match.<br />
              <span style={{ fontSize: 12 }}>Add a condition below to define when this page is active.</span>
            </div>
          ) : null}

          {builder.conditions.map((c, i) => (
            <CondCard
              key={c.id}
              cond={c}
              index={i}
              cfg={cfg}
              knownOcrLabels={frameOcrLabels}
              onChange={(patch) => updateCond(i, patch)}
              onRemove={() => removeCond(i)}
            />
          ))}

          <div className="row">
            <button type="button" onClick={addCond}>
              + Add condition
            </button>
            <button
              type="button"
              onClick={handleSaveBuilder}
              style={{ background: "#1a2a4a", borderColor: "#4c8dff", color: "#4c8dff" }}
            >
              Save page
            </button>
          </div>
        </div>
      ) : null}

      {/* ── Advanced JSON editor ── */}
      {showAdvanced ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            Edit the match predicate as JSON. Supports: comparison, logical, exists, change, transition, temporal.
          </div>
          {jsonError ? (
            <div style={{ color: "#ff8f8f", fontSize: 12, padding: "6px 10px", background: "rgba(255,80,80,0.08)", borderRadius: 4 }}>
              {jsonError}
            </div>
          ) : null}
          <div className="row" style={{ flexWrap: "wrap" }}>
            <button type="button" onClick={() => {
              setJsonText(JSON.stringify({
                kind: "comparison",
                left: { kind: "field", path: ["ocr", "by_label", "title", 0, "text"] },
                op: "contains",
                right: { kind: "literal", value: "Home" },
              }, null, 2));
            }}>Template: OCR contains</button>
            <button type="button" onClick={() => {
              setJsonText(JSON.stringify({
                kind: "comparison",
                left: { kind: "field", path: ["class_counts", "person"] },
                op: ">=",
                right: { kind: "literal", value: 1 },
              }, null, 2));
            }}>Template: class count</button>
            <button type="button" onClick={() => {
              setJsonText(JSON.stringify({
                kind: "comparison",
                left: { kind: "field", path: ["zones", cfg.zones[0]?.id ?? "zone_id", "occupancy"] },
                op: ">",
                right: { kind: "literal", value: 0 },
              }, null, 2));
            }}>Template: exclusive zone occupancy</button>
            <button type="button" onClick={() => {
              setJsonText(JSON.stringify({
                kind: "comparison",
                left: { kind: "field", path: ["zone_membership", cfg.zones[0]?.id ?? "zone_id", "occupancy"] },
                op: ">",
                right: { kind: "literal", value: 0 },
              }, null, 2));
            }}>Template: physical zone occupancy</button>
          </div>
          <textarea
            style={{
              width: "100%",
              minHeight: 280,
              background: "#0b0d12",
              color: "#e8eaed",
              border: "1px solid #2a2f3a",
              fontFamily: "monospace",
              fontSize: 12,
              padding: 8,
            }}
            value={jsonText}
            onChange={(e) => { setJsonText(e.target.value); setJsonError(null); }}
          />
          <div className="row">
            <button
              type="button"
              onClick={handleSaveJson}
              style={{ background: "#1a2a4a", borderColor: "#4c8dff", color: "#4c8dff" }}
            >
              Validate + save
            </button>
            <button type="button" onClick={() => {
              setJsonText(JSON.stringify(page.match, null, 2));
              setJsonError(null);
            }}>
              Reset to saved
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────────

export function ZonesPagesEditor() {
  const { state, dispatch, frameState } = useProject();
  const cfg = state.config;
  const [zoneDraft, setZoneDraft] = useState<Partial<ZoneDefinition> | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(cfg.pages[0]?.id ?? null);

  useEffect(() => {
    if (!selectedPageId && cfg.pages[0]) setSelectedPageId(cfg.pages[0].id);
    if (selectedPageId && !cfg.pages.some((p) => p.id === selectedPageId)) {
      setSelectedPageId(cfg.pages[0]?.id ?? null);
    }
  }, [cfg.pages, selectedPageId]);

  const applyConfig = useCallback(
    (next: ClassificationConfig) => {
      const parsed = classificationConfigSchema.parse(next);
      dispatch({ type: "update_config", config: parsed });
    },
    [dispatch],
  );

  // ── Zone actions ──

  const addZone = () => {
    const z: ZoneDefinition = {
      id: newId("zone"),
      name: "New zone",
      priority: 0,
      geometry: { type: "rectangle", x: 0, y: 0, width: 200, height: 200 },
      parent_classes: [],
      object_classes: [],
      object_class_ranges: [],
    };
    applyConfig({ ...cfg, zones: [...cfg.zones, z] });
  };

  const saveZoneFromDraft = () => {
    if (!zoneDraft?.id) return;
    const next = cfg.zones.map((z) => (z.id === zoneDraft.id ? ({ ...z, ...zoneDraft } as ZoneDefinition) : z));
    applyConfig({ ...cfg, zones: next });
    setZoneDraft(null);
  };

  const deleteZone = (id: string) => {
    const refs = eventsReferencingZoneId(cfg, id);
    if (refs.length) {
      const ok = window.confirm(
        `Zone "${id}" is referenced by events: ${refs.join(", ")}. Delete anyway?`,
      );
      if (!ok) return;
    }
    applyConfig({ ...cfg, zones: cfg.zones.filter((z) => z.id !== id) });
    if (zoneDraft?.id === id) setZoneDraft(null);
  };

  const moveZone = (id: string, dir: -1 | 1) => {
    const i = cfg.zones.findIndex((z) => z.id === id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= cfg.zones.length) return;
    const z = [...cfg.zones];
    [z[i], z[j]] = [z[j]!, z[i]!];
    applyConfig({ ...cfg, zones: z });
  };

  // ── Page actions ──

  const addPage = () => {
    const match: PredicateNode = { kind: "logical", op: "and", children: [] };
    const p: PageDefinition = {
      id: newId("page"),
      name: "New page",
      priority: 0,
      match,
    };
    applyConfig({ ...cfg, pages: [...cfg.pages, p] });
    setSelectedPageId(p.id);
  };

  const savePage = (id: string, match: PredicateNode, name: string, priority: number) => {
    applyConfig({
      ...cfg,
      pages: cfg.pages.map((p) => (p.id === id ? { ...p, name, priority, match } : p)),
    });
    dispatch({ type: "set_error", message: null });
  };

  const deletePage = (id: string) => {
    applyConfig({ ...cfg, pages: cfg.pages.filter((p) => p.id !== id) });
    setSelectedPageId(cfg.pages.find((p) => p.id !== id)?.id ?? null);
  };

  const selectedPage = useMemo(
    () => cfg.pages.find((p) => p.id === selectedPageId) ?? null,
    [cfg.pages, selectedPageId],
  );

  const pageMatchResult = useMemo(() => {
    if (!selectedPage) return null;
    try {
      const stateAt = () => frameState;
      const ctx: EvalContext = { evalFrame: state.currentFrame, lastMatchFrame: null, stateAt };
      return evaluatePredicate(selectedPage.match, frameState, state.currentFrame, ctx);
    } catch {
      return null;
    }
  }, [frameState, selectedPage, state.currentFrame]);

  const knownOcrLabels = useMemo(
    () => Object.keys(frameState.ocr_by_label).sort(),
    [frameState.ocr_by_label],
  );

  const pageIdDuplicates = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of cfg.pages) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    return new Set([...counts.entries()].filter(([, c]) => c > 1).map(([id]) => id));
  }, [cfg.pages]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 980 }}>
      <p className="muted">
        Zones mark regions of the frame; pages identify distinct screen states. Event predicates can reference
        both. Deleting a zone that is used by an event will break those predicates.
      </p>

      {/* ── Zones ── */}
      <section>
        <h4>Zones</h4>
        <button type="button" onClick={addZone}>Add zone</button>
        <table className="table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>id</th><th>name</th><th>priority</th><th>class ranges</th><th>geometry</th><th />
            </tr>
          </thead>
          <tbody>
            {cfg.zones.map((z) => (
              <tr key={z.id}>
                <td><code>{z.id}</code></td>
                <td>{z.name}</td>
                <td>{z.priority}</td>
                <td className="muted" style={{ maxWidth: 140, fontSize: 11 }}>{rangeSummary(z.object_class_ranges)}</td>
                <td>
                  {z.geometry.type === "rectangle"
                    ? <span>{z.geometry.x},{z.geometry.y} {z.geometry.width}×{z.geometry.height}</span>
                    : "polygon"}
                </td>
                <td>
                  <button type="button" onClick={() => setZoneDraft({ ...z, object_class_ranges: z.object_class_ranges ?? [], object_classes: z.object_classes ?? [], parent_classes: z.parent_classes ?? [] })}>Edit</button>
                  <button type="button" onClick={() => moveZone(z.id, -1)}>Up</button>
                  <button type="button" onClick={() => moveZone(z.id, 1)}>Down</button>
                  <button type="button" onClick={() => deleteZone(z.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {zoneDraft?.id ? (
          <div style={{ border: "1px solid #2a2f3a", padding: 10, marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            <strong>Edit zone {zoneDraft.id}</strong>
            <label>Name <input value={zoneDraft.name ?? ""} onChange={(e) => setZoneDraft((d) => ({ ...d, name: e.target.value }))} /></label>
            <label>Priority <input type="number" value={zoneDraft.priority ?? 0} onChange={(e) => setZoneDraft((d) => ({ ...d, priority: Number(e.target.value) }))} /></label>
            <div style={{ borderTop: "1px solid #2a2f3a", paddingTop: 8 }}>
              <div className="muted" style={{ marginBottom: 6 }}>
                Which object classes count inside this zone. Use numeric class IDs (e.g. 370–399) or exact names.
                Empty = all classes allowed.
              </div>
              <label style={{ display: "block", marginBottom: 6 }}>
                Numeric class ID ranges{" "}
                <button type="button" onClick={() => setZoneDraft((d) => ({ ...d, object_class_ranges: [...(d?.object_class_ranges ?? []), { min: 0, max: 0 }] }))}>
                  Add range
                </button>
              </label>
              {(zoneDraft.object_class_ranges ?? []).length === 0 ? (
                <div className="muted" style={{ marginBottom: 8 }}>No ranges — all classes allowed.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
                  {(zoneDraft.object_class_ranges ?? []).map((r, idx) => (
                    <div key={idx} className="row" style={{ alignItems: "center" }}>
                      <span className="muted">from</span>
                      <input type="number" value={r.min} onChange={(e) => { const min = Math.floor(Number(e.target.value)); setZoneDraft((d) => { const ranges = [...(d?.object_class_ranges ?? [])]; ranges[idx] = { ...ranges[idx]!, min }; return { ...d, object_class_ranges: ranges }; }); }} />
                      <span className="muted">to</span>
                      <input type="number" value={r.max} onChange={(e) => { const max = Math.floor(Number(e.target.value)); setZoneDraft((d) => { const ranges = [...(d?.object_class_ranges ?? [])]; ranges[idx] = { ...ranges[idx]!, max }; return { ...d, object_class_ranges: ranges }; }); }} />
                      <button type="button" onClick={() => setZoneDraft((d) => ({ ...d, object_class_ranges: (d?.object_class_ranges ?? []).filter((_, j) => j !== idx) }))}>Remove</button>
                    </div>
                  ))}
                </div>
              )}
              <label style={{ display: "block", marginBottom: 4 }}>
                Exact class names (comma-separated){" "}
                <input style={{ width: "100%", maxWidth: 480 }} value={(zoneDraft.object_classes ?? []).join(", ")} onChange={(e) => setZoneDraft((d) => ({ ...d, object_classes: splitCommaList(e.target.value) }))} placeholder="e.g. person, vehicle" />
              </label>
              <label style={{ display: "block" }}>
                Parent class names (comma-separated){" "}
                <input style={{ width: "100%", maxWidth: 480 }} value={(zoneDraft.parent_classes ?? []).join(", ")} onChange={(e) => setZoneDraft((d) => ({ ...d, parent_classes: splitCommaList(e.target.value) }))} />
              </label>
            </div>
            {zoneDraft.geometry?.type === "rectangle" ? (
              <div className="row" style={{ flexWrap: "wrap" }}>
                {(["x", "y", "width", "height"] as const).map((k) => {
                  const g = zoneDraft.geometry;
                  if (g?.type !== "rectangle") return null;
                  return (
                    <label key={k}>{k} <input type="number" value={g[k]} onChange={(e) => { const n = Number(e.target.value); setZoneDraft((d) => d?.geometry?.type === "rectangle" ? { ...d, geometry: { ...d.geometry, [k]: n } } : d); }} /></label>
                  );
                })}
              </div>
            ) : null}
            <div className="row">
              <button type="button" onClick={saveZoneFromDraft}>Save zone</button>
              <button type="button" onClick={() => setZoneDraft(null)}>Cancel</button>
            </div>
          </div>
        ) : null}
      </section>

      {/* ── Pages ── */}
      <section>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
          <h4 style={{ margin: 0 }}>Pages</h4>
          <button type="button" onClick={addPage}>+ New page</button>
          <span className="muted" style={{ fontSize: 12 }}>
            A page is a named screen state identified by a set of conditions. Higher priority wins when multiple pages match.
          </span>
        </div>

        {cfg.pages.length === 0 ? (
          <div style={{
            padding: "32px 20px",
            textAlign: "center",
            border: "1px dashed #2a2f3a",
            borderRadius: 6,
            color: "#6b7385",
          }}>
            No pages yet. Click <strong>+ New page</strong> to define a screen state.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 12 }}>
            {/* Page list */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {cfg.pages.map((p) => {
                const active = p.id === selectedPageId;
                let matchDot: string | null = null;
                try {
                  const stateAt = () => frameState;
                  const ctx: EvalContext = { evalFrame: state.currentFrame, lastMatchFrame: null, stateAt };
                  matchDot = evaluatePredicate(p.match, frameState, state.currentFrame, ctx) ? "#12b76a" : "#2a2f3a";
                } catch { matchDot = "#2a2f3a"; }

                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelectedPageId(p.id)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      border: active ? "1px solid #4c8dff" : "1px solid #2a2f3a",
                      background: active ? "#131a29" : "#0b0d12",
                      color: "#e8eaed",
                      padding: "8px 10px",
                      cursor: "pointer",
                      borderRadius: 5,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: matchDot ?? "#2a2f3a", flexShrink: 0 }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.name}
                      </div>
                      <div className="muted" style={{ fontSize: 11 }}>
                        pri {p.priority}{pageIdDuplicates.has(p.id) ? " · ⚠ duplicate id" : ""}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Page editor */}
            <div style={{ border: "1px solid #2a2f3a", borderRadius: 6, padding: 14 }}>
              {!selectedPage ? (
                <div className="muted">Select a page to edit.</div>
              ) : (
                <PageEditor
                  key={selectedPage.id}
                  page={selectedPage}
                  cfg={cfg}
                  currentFrame={state.currentFrame}
                  frameOcrLabels={knownOcrLabels}
                  isMatch={pageMatchResult}
                  onSave={(match, name, priority) => savePage(selectedPage.id, match, name, priority)}
                  onDelete={() => deletePage(selectedPage.id)}
                />
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
