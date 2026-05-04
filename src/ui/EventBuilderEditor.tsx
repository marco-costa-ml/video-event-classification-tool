import { useEffect, useMemo, useState } from "react";
import { useProject } from "@/context/ProjectContext";
import {
  classificationConfigSchema,
  type ClassificationConfig,
  type EventDefinition,
  type PredicateNode,
} from "@/schemas";
import { predicateNodeSchema } from "@/schemas/predicates";

// ─── Rule model ─────────────────────────────────────────────────────────────────

type RuleKind =
  | "ocr_contains"
  | "ocr_not_contains"
  | "ocr_equals"
  | "ocr_not_equals"
  | "ocr_not_empty"
  | "ocr_number_op"
  | "zone_occupancy"
  | "zone_physical_occupancy"
  | "class_count"
  | "object_entered_zone"
  | "object_physically_entered_zone"
  | "value_changed"
  | "page_active"
  | "page_transition";

type CompOp = ">" | ">=" | "==" | "!=" | "<" | "<=";
type ChangeOpDraft = "changed" | "unchanged" | "increase" | "decrease" | "delta_gt" | "delta_lt" | "increase_lt";

type RuleDraft = {
  id: string;
  frameOffset: number;
  kind: RuleKind;
  // OCR fields
  ocrLabel: string;
  searchText: string;
  /** For "OCR contains": look back this many frames (>=1). */
  containsWithinFrames: number;
  numOp: CompOp;
  numValue: number;
  // Zone fields
  zoneId: string;
  occupancyOp: CompOp;
  threshold: number;
  // Class / object fields
  className: string;
  countOp: CompOp;
  countValue: number;
  // Window / temporal
  windowFrames: number;
  // Value-change fields
  changeOp: ChangeOpDraft;
  changeWindow: number;
  changeThreshold: number;
  // Page fields
  pageId: string;
  fromPageId: string;
  toPageId: string;
};

type EventDraft = {
  id: string;
  name: string;
  priority: number;
  cooldown_frames: number;
  dedupe_merge: number;
  rules: RuleDraft[];
};

// ─── Helpers ─────────────────────────────────────────────────────────────────────

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function defaultRuleDraft(cfg: ClassificationConfig): RuleDraft {
  return {
    id: newId("rule"),
    frameOffset: 0,
    kind: "zone_occupancy",
    ocrLabel: "",
    searchText: "",
    containsWithinFrames: 1,
    numOp: ">=",
    numValue: 0,
    zoneId: cfg.zones[0]?.id ?? "",
    occupancyOp: ">",
    threshold: 0,
    className: "",
    countOp: ">=",
    countValue: 1,
    windowFrames: 5,
    changeOp: "changed",
    changeWindow: 5,
    changeThreshold: 0,
    pageId: cfg.pages[0]?.id ?? "",
    fromPageId: "",
    toPageId: cfg.pages[0]?.id ?? "",
  };
}

function defaultEventDraft(cfg: ClassificationConfig): EventDraft {
  return {
    id: newId("ev"),
    name: "New event",
    priority: 10,
    cooldown_frames: 30,
    dedupe_merge: 3,
    rules: [defaultRuleDraft(cfg)],
  };
}

// ─── Predicate builder ───────────────────────────────────────────────────────────

function buildRulePredicate(r: RuleDraft): PredicateNode {
  switch (r.kind) {
    case "ocr_contains": {
      const path = ["ocr", "by_label", r.ocrLabel, 0, "text"] as (string | number)[];
      const within = Math.max(1, Math.floor(r.containsWithinFrames || 1));
      if (within === 1) {
        return {
          kind: "comparison",
          left: { kind: "field", path },
          op: "contains",
          right: { kind: "literal", value: r.searchText },
        };
      }
      const children: PredicateNode[] = [];
      for (let i = 0; i < within; i++) {
        // Lookahead: true if it matches at least once within the *next* N frames (including current).
        const left =
          i === 0
            ? ({ kind: "field", path } as const)
            : ({ kind: "window_field", path, offset_frames: i } as const);
        children.push({
          kind: "comparison",
          left,
          op: "contains",
          right: { kind: "literal", value: r.searchText },
        });
      }
      return { kind: "logical", op: "or", children };
    }
    case "ocr_not_contains":
      return { kind: "comparison", left: { kind: "field", path: ["ocr", "by_label", r.ocrLabel, 0, "text"] }, op: "not_contains", right: { kind: "literal", value: r.searchText } };
    case "ocr_equals": {
      const ocrPath = ["ocr", "by_label", r.ocrLabel, 0, "text"] as const;
      if (r.searchText === "")
        // Null check: absent (not_exists) OR empty string OR "NaN" from parquet
        return {
          kind: "logical", op: "or", children: [
            { kind: "not_exists", path: [...ocrPath] },
            { kind: "comparison", left: { kind: "field", path: [...ocrPath] }, op: "==", right: { kind: "literal", value: "" } },
            { kind: "comparison", left: { kind: "field", path: [...ocrPath] }, op: "==", right: { kind: "literal", value: "NaN" } },
          ],
        } satisfies PredicateNode;
      return { kind: "comparison", left: { kind: "field", path: ["ocr", "by_label", r.ocrLabel, 0, "text"] }, op: "==", right: { kind: "literal", value: r.searchText } };
    }
    case "ocr_not_equals":
      return { kind: "comparison", left: { kind: "field", path: ["ocr", "by_label", r.ocrLabel, 0, "text"] }, op: "!=", right: { kind: "literal", value: r.searchText } };
    case "ocr_not_empty":
      return { kind: "exists", path: ["ocr", "by_label", r.ocrLabel, 0, "text"] };
    case "ocr_number_op":
      return { kind: "comparison", left: { kind: "field", path: ["ocr", "by_label", r.ocrLabel, 0, "text"] }, op: r.numOp, right: { kind: "literal", value: r.numValue } };
    case "zone_occupancy":
      return { kind: "comparison", left: { kind: "field", path: ["zones", r.zoneId, "occupancy"] }, op: r.occupancyOp, right: { kind: "literal", value: r.threshold } };
    case "zone_physical_occupancy":
      return { kind: "comparison", left: { kind: "field", path: ["zone_membership", r.zoneId, "occupancy"] }, op: r.occupancyOp, right: { kind: "literal", value: r.threshold } };
    case "class_count":
      return { kind: "comparison", left: { kind: "field", path: ["class_counts", r.className] }, op: r.countOp, right: { kind: "literal", value: r.countValue } };
    case "object_entered_zone":
      return { kind: "change", path: ["zones", r.zoneId, "occupancy"], op: "increase", window_frames: Math.max(1, r.windowFrames) };
    case "object_physically_entered_zone":
      return { kind: "change", path: ["zone_membership", r.zoneId, "occupancy"], op: "increase", window_frames: Math.max(1, r.windowFrames) };
    case "value_changed":
      if (r.changeOp === "delta_gt" || r.changeOp === "delta_lt" || r.changeOp === "increase_lt") {
        return { kind: "change", path: ["ocr", "by_label", r.ocrLabel, 0, "text"], op: r.changeOp, threshold: r.changeThreshold, window_frames: Math.max(1, r.changeWindow) };
      }
      return { kind: "change", path: ["ocr", "by_label", r.ocrLabel, 0, "text"], op: r.changeOp, window_frames: Math.max(1, r.changeWindow) };
    case "page_active":
      return { kind: "comparison", left: { kind: "field", path: ["page", "id"] }, op: "==", right: { kind: "literal", value: r.pageId } };
    case "page_transition":
      return {
        kind: "transition",
        transition: "page",
        from: r.fromPageId ? { kind: "literal", value: r.fromPageId } : undefined,
        to: r.toPageId ? { kind: "literal", value: r.toPageId } : undefined,
        window_frames: Math.max(1, r.windowFrames),
      };
  }
}

function buildEventPredicate(draft: EventDraft): PredicateNode {
  const wrapped: PredicateNode[] = draft.rules.map((r) => {
    const child = buildRulePredicate(r);
    if (r.frameOffset === 0) return child;
    return { kind: "temporal", anchor: "eval_frame", offset_frames: r.frameOffset, window_before: 0, window_after: 0, child } satisfies PredicateNode;
  });
  if (wrapped.length === 1) return wrapped[0]!;
  return { kind: "logical", op: "and", children: wrapped };
}

// ─── Predicate → draft (round-trip) ─────────────────────────────────────────────

function tryParseRule(node: PredicateNode, cfg: ClassificationConfig): RuleDraft | null {
  const base = defaultRuleDraft(cfg);
  // OCR contains within N frames: OR of "contains" checks over window_field offsets.
  if (node.kind === "logical" && node.op === "or" && node.children.length >= 2) {
    const comparisons = node.children.filter(
      (c): c is Extract<PredicateNode, { kind: "comparison" }> => c.kind === "comparison",
    );
    if (comparisons.length === node.children.length) {
      const offsets: number[] = [];
      let label: string | null = null;
      let text: string | null = null;
      let ok = true;
      for (const c of comparisons) {
        if (c.op !== "contains") {
          ok = false;
          break;
        }
        if (c.right.kind !== "literal") {
          ok = false;
          break;
        }
        const v = String(c.right.value ?? "");
        if (text === null) text = v;
        else if (text !== v) {
          ok = false;
          break;
        }
        // left must be OCR text field, either current or window_field.
        const left = c.left;
        const isField =
          (left.kind === "field" || left.kind === "window_field") &&
          left.path[0] === "ocr" &&
          left.path[1] === "by_label" &&
          left.path[3] === 0 &&
          left.path[4] === "text";
        if (!isField) {
          ok = false;
          break;
        }
        const lb = String(left.path[2] ?? "");
        if (label === null) label = lb;
        else if (label !== lb) {
          ok = false;
          break;
        }
        const off = left.kind === "window_field" ? left.offset_frames : 0;
        // Lookahead only: offsets must be >= 0
        if (!Number.isFinite(off) || off < 0) {
          ok = false;
          break;
        }
        offsets.push(Math.trunc(off));
      }
      if (ok && label !== null && text !== null) {
        const maxOff = Math.max(...offsets);
        const within = Math.max(1, 1 + Math.abs(maxOff));
        return {
          ...base,
          id: newId("rule"),
          kind: "ocr_contains",
          ocrLabel: label,
          searchText: text,
          containsWithinFrames: within,
        };
      }
    }
  }
  if (node.kind === "exists") {
    const p = node.path;
    if (p[0] === "ocr" && p[1] === "by_label" && p.length >= 3)
      return { ...base, id: newId("rule"), kind: "ocr_not_empty", ocrLabel: String(p[2] ?? "") };
  }
  if (node.kind === "not_exists") {
    const p = node.path;
    if (p[0] === "ocr" && p[1] === "by_label" && p.length >= 3)
      return { ...base, id: newId("rule"), kind: "ocr_equals", ocrLabel: String(p[2] ?? ""), searchText: "" };
  }
  // Null-check pattern: logical or [not_exists, == "", == "NaN"]
  if (node.kind === "logical" && node.op === "or" && node.children.length >= 2) {
    const notEx = node.children.find((c): c is Extract<PredicateNode, { kind: "not_exists" }> => c.kind === "not_exists");
    if (notEx) {
      const p = notEx.path;
      if (p[0] === "ocr" && p[1] === "by_label" && p.length >= 3)
        return { ...base, id: newId("rule"), kind: "ocr_equals", ocrLabel: String(p[2] ?? ""), searchText: "" };
    }
  }
  if (node.kind === "comparison" && node.left.kind === "field" && node.right.kind === "literal") {
    const path = node.left.path; const op = node.op; const val = node.right.value;
    // OCR text
    if (path[0] === "ocr" && path[1] === "by_label" && path[3] === 0 && path[4] === "text") {
      const label = String(path[2] ?? ""); const text = String(val ?? "");
      if (op === "contains")     return { ...base, id: newId("rule"), kind: "ocr_contains",     ocrLabel: label, searchText: text, containsWithinFrames: 1 };
      if (op === "not_contains") return { ...base, id: newId("rule"), kind: "ocr_not_contains", ocrLabel: label, searchText: text };
      if (op === "==")           return { ...base, id: newId("rule"), kind: "ocr_equals",       ocrLabel: label, searchText: text };
      if (op === "!=")           return { ...base, id: newId("rule"), kind: "ocr_not_equals",   ocrLabel: label, searchText: text };
      if (op === ">" || op === ">=" || op === "<" || op === "<=")
        return { ...base, id: newId("rule"), kind: "ocr_number_op", ocrLabel: label, numOp: op as CompOp, numValue: Number(val) };
    }
    // Zone occupancy
    if (path[0] === "zones" && path.length === 3 && path[2] === "occupancy") {
      const zoneId = String(path[1] ?? "");
      if (op === ">" || op === ">=" || op === "<" || op === "<=" || op === "==" || op === "!=")
        return { ...base, id: newId("rule"), kind: "zone_occupancy", zoneId, occupancyOp: op as CompOp, threshold: Number(val) };
    }
    if (path[0] === "zone_membership" && path.length === 3 && path[2] === "occupancy") {
      const zoneId = String(path[1] ?? "");
      if (op === ">" || op === ">=" || op === "<" || op === "<=" || op === "==" || op === "!=")
        return { ...base, id: newId("rule"), kind: "zone_physical_occupancy", zoneId, occupancyOp: op as CompOp, threshold: Number(val) };
    }
    // Class count
    if (path[0] === "class_counts" && path.length === 2) {
      const className = String(path[1] ?? "");
      if (op === ">" || op === ">=" || op === "<" || op === "<=" || op === "==" || op === "!=")
        return { ...base, id: newId("rule"), kind: "class_count", className, countOp: op as CompOp, countValue: Number(val) };
    }
    // Page active
    if (path[0] === "page" && path[1] === "id" && op === "==")
      return { ...base, id: newId("rule"), kind: "page_active", pageId: String(val ?? "") };
  }
  if (node.kind === "change") {
    const path = node.path;
    if (path[0] === "ocr" && path[1] === "by_label" && path.length >= 3)
      return { ...base, id: newId("rule"), kind: "value_changed", ocrLabel: String(path[2] ?? ""), changeOp: node.op as ChangeOpDraft, changeWindow: node.window_frames, changeThreshold: node.threshold ?? 0 };
    if (path[0] === "zones" && path.length === 3 && path[2] === "occupancy" && node.op === "increase")
      return { ...base, id: newId("rule"), kind: "object_entered_zone", zoneId: String(path[1] ?? ""), windowFrames: node.window_frames };
    if (path[0] === "zone_membership" && path.length === 3 && path[2] === "occupancy" && node.op === "increase")
      return { ...base, id: newId("rule"), kind: "object_physically_entered_zone", zoneId: String(path[1] ?? ""), windowFrames: node.window_frames };
  }
  if (node.kind === "transition" && node.transition === "page") {
    return { ...base, id: newId("rule"), kind: "page_transition", fromPageId: node.from?.kind === "literal" ? String(node.from.value) : "", toPageId: node.to?.kind === "literal" ? String(node.to.value) : "", windowFrames: node.window_frames };
  }
  return null;
}

function tryParseNodeWithOffset(node: PredicateNode, cfg: ClassificationConfig): RuleDraft | null {
  if (node.kind === "temporal" && node.anchor === "eval_frame") {
    const rule = tryParseRule(node.child, cfg);
    if (rule) return { ...rule, frameOffset: node.offset_frames };
  }
  const rule = tryParseRule(node, cfg);
  return rule ? { ...rule, frameOffset: 0 } : null;
}

function tryParseEventPredicate(pred: PredicateNode, cfg: ClassificationConfig): RuleDraft[] | null {
  const single = tryParseNodeWithOffset(pred, cfg);
  if (single) return [single];
  if (pred.kind === "logical" && pred.op === "and") {
    const rules = pred.children.map((c) => tryParseNodeWithOffset(c, cfg));
    if (rules.every((r): r is RuleDraft => r !== null)) return rules;
  }
  return null;
}

// ─── Rule card ───────────────────────────────────────────────────────────────────

const COMP_OPS: { value: CompOp; label: string }[] = [
  { value: ">=", label: "≥" }, { value: ">", label: ">" },
  { value: "==", label: "=" }, { value: "!=", label: "≠" },
  { value: "<=", label: "≤" }, { value: "<",  label: "<" },
];

const KIND_META: Record<RuleKind, { label: string; color: string; group: string }> = {
  ocr_contains:       { label: "OCR text contains",           color: "#4c8dff", group: "OCR" },
  ocr_not_contains:   { label: "OCR text does NOT contain",   color: "#4c8dff", group: "OCR" },
  ocr_equals:         { label: "OCR text exactly equals",     color: "#4c8dff", group: "OCR" },
  ocr_not_equals:     { label: "OCR text does NOT equal",     color: "#4c8dff", group: "OCR" },
  ocr_not_empty:      { label: "OCR label is present",        color: "#4c8dff", group: "OCR" },
  ocr_number_op:      { label: "OCR value (numeric)",         color: "#4c8dff", group: "OCR" },
  zone_occupancy:     { label: "Zone occupancy (exclusive)",  color: "#f59e0b", group: "Zone / Objects" },
  zone_physical_occupancy: { label: "Zone occupancy (physical)", color: "#f59e0b", group: "Zone / Objects" },
  class_count:        { label: "Object class count",          color: "#f59e0b", group: "Zone / Objects" },
  object_entered_zone:{ label: "Objects entered zone (exclusive)", color: "#f59e0b", group: "Zone / Objects" },
  object_physically_entered_zone: { label: "Objects entered zone (physical)", color: "#f59e0b", group: "Zone / Objects" },
  value_changed:      { label: "OCR value changed",           color: "#a78bfa", group: "Changes" },
  page_active:        { label: "Page is active",              color: "#12b76a", group: "Pages" },
  page_transition:    { label: "Page changed",                color: "#12b76a", group: "Pages" },
};

type RuleCardProps = {
  rule: RuleDraft;
  index: number;
  total: number;
  cfg: ClassificationConfig;
  knownOcrLabels: string[];
  onChange: (patch: Partial<RuleDraft>) => void;
  onRemove: () => void;
};

function OcrLabelInput({ value, known, onChange }: { value: string; known: string[]; onChange: (v: string) => void }) {
  if (known.length > 0) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {known.map((l) => <option key={l} value={l}>{l}</option>)}
        {!known.includes(value) && value ? <option value={value}>{value} (custom)</option> : null}
      </select>
    );
  }
  return <input value={value} placeholder="e.g. title" onChange={(e) => onChange(e.target.value)} />;
}

function RuleCard({ rule, index, total, cfg, knownOcrLabels, onChange, onRemove }: RuleCardProps) {
  const meta = KIND_META[rule.kind];
  const offsetLabel = rule.frameOffset === 0 ? "current frame" : rule.frameOffset < 0 ? `${Math.abs(rule.frameOffset)} frames before` : `${rule.frameOffset} frames after`;

  // Group options for the select
  const kindGroups: { group: string; kinds: RuleKind[] }[] = [
    { group: "OCR", kinds: ["ocr_contains", "ocr_not_contains", "ocr_equals", "ocr_not_equals", "ocr_not_empty", "ocr_number_op"] },
    { group: "Zone / Objects", kinds: ["zone_occupancy", "zone_physical_occupancy", "class_count", "object_entered_zone", "object_physically_entered_zone"] },
    { group: "Changes", kinds: ["value_changed"] },
    { group: "Pages", kinds: ["page_active", "page_transition"] },
  ];

  return (
    <div style={{ border: `1px solid #2a2f3a`, borderLeft: `3px solid ${meta.color}`, borderRadius: 6, padding: "10px 12px", background: "#0f1318", display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#9aa3b2", letterSpacing: "0.04em" }}>RULE {index + 1}</span>
        {total > 1 ? <button type="button" onClick={onRemove} style={{ fontSize: 11, padding: "2px 8px" }}>Remove</button> : null}
      </div>

      {/* Type selector */}
      <div className="row" style={{ alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <label style={{ fontSize: 13 }}>
          Type{" "}
          <select value={rule.kind} onChange={(e) => onChange({ kind: e.target.value as RuleKind })}>
            {kindGroups.map(({ group, kinds }) => (
              <optgroup key={group} label={group}>
                {kinds.map((k) => <option key={k} value={k}>{KIND_META[k].label}</option>)}
              </optgroup>
            ))}
          </select>
        </label>

        {/* Frame offset */}
        <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
          Frame offset
          <input type="number" style={{ width: 68 }} value={rule.frameOffset} onChange={(e) => onChange({ frameOffset: Math.floor(Number(e.target.value)) })} />
        </label>
        <span style={{ fontSize: 11, color: rule.frameOffset === 0 ? "#6b7385" : "#4c8dff", background: rule.frameOffset === 0 ? "transparent" : "rgba(76,141,255,0.1)", padding: "2px 7px", borderRadius: 4 }}>
          @ {offsetLabel}
        </span>
      </div>

      {/* ── OCR rules ── */}
      {(rule.kind === "ocr_contains" || rule.kind === "ocr_not_contains" || rule.kind === "ocr_equals" || rule.kind === "ocr_not_equals") ? (
        <div className="row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <label style={{ fontSize: 13 }}>OCR label <OcrLabelInput value={rule.ocrLabel} known={knownOcrLabels} onChange={(v) => onChange({ ocrLabel: v })} /></label>
          <label style={{ fontSize: 13 }}>
            {rule.kind === "ocr_contains" ? "Contains" : rule.kind === "ocr_not_contains" ? "Does not contain" : rule.kind === "ocr_equals" ? "Exactly equals" : "Does not equal"}
            {" "}<input value={rule.searchText} placeholder={rule.kind === "ocr_equals" ? "leave blank to check absent/null" : "text to match"} onChange={(e) => onChange({ searchText: e.target.value })} />
          </label>
          {rule.kind === "ocr_contains" ? (
            <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
              Within
              <input
                type="number"
                min={1}
                step={1}
                style={{ width: 64 }}
                value={Math.max(1, Math.floor(rule.containsWithinFrames || 1))}
                onChange={(e) => onChange({ containsWithinFrames: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
              />
              frames
            </label>
          ) : null}
          {rule.kind === "ocr_equals" && rule.searchText === "" ? (
            <span style={{ fontSize: 11, color: "#f59e0b", background: "rgba(245,158,11,0.1)", padding: "2px 8px", borderRadius: 4 }}>
              null check — passes when label is absent or has no value
            </span>
          ) : null}
        </div>
      ) : null}

      {rule.kind === "ocr_not_empty" ? (
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 13 }}>OCR label <OcrLabelInput value={rule.ocrLabel} known={knownOcrLabels} onChange={(v) => onChange({ ocrLabel: v })} /></label>
          <span className="muted" style={{ fontSize: 12 }}>Passes whenever this label has any text</span>
        </div>
      ) : null}

      {rule.kind === "ocr_number_op" ? (
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 13 }}>OCR label <OcrLabelInput value={rule.ocrLabel} known={knownOcrLabels} onChange={(v) => onChange({ ocrLabel: v })} /></label>
          <label style={{ fontSize: 13 }}>
            Value{" "}
            <select value={rule.numOp} onChange={(e) => onChange({ numOp: e.target.value as CompOp })} style={{ width: 52 }}>
              {COMP_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <input type="number" style={{ width: 80 }} value={rule.numValue} onChange={(e) => onChange({ numValue: Number(e.target.value) })} />
          <span className="muted" style={{ fontSize: 12 }}>The OCR text is parsed as a number for comparison</span>
        </div>
      ) : null}

      {/* ── Zone rules ── */}
      {(rule.kind === "zone_occupancy" || rule.kind === "zone_physical_occupancy") ? (
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 13 }}>
            Zone{" "}
            <select value={rule.zoneId} onChange={(e) => onChange({ zoneId: e.target.value })}>
              {cfg.zones.length === 0 ? <option value="">No zones defined</option> : cfg.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 13 }}>
            Object count{" "}
            <select value={rule.occupancyOp} onChange={(e) => onChange({ occupancyOp: e.target.value as CompOp })} style={{ width: 52 }}>
              {COMP_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <input type="number" style={{ width: 64 }} min={0} value={rule.threshold} onChange={(e) => onChange({ threshold: Number(e.target.value) })} />
          <span className="muted" style={{ fontSize: 12 }}>
            {rule.kind === "zone_physical_occupancy" ? "objects physically inside zone, ignoring priority" : "objects assigned to this zone after priority rules"}
          </span>
        </div>
      ) : null}

      {rule.kind === "class_count" ? (
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 13 }}>Class name / ID <input value={rule.className} placeholder="e.g. 51 or person" onChange={(e) => onChange({ className: e.target.value })} /></label>
          <label style={{ fontSize: 13 }}>
            Count{" "}
            <select value={rule.countOp} onChange={(e) => onChange({ countOp: e.target.value as CompOp })} style={{ width: 52 }}>
              {COMP_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <input type="number" style={{ width: 64 }} min={0} value={rule.countValue} onChange={(e) => onChange({ countValue: Number(e.target.value) })} />
          <span className="muted" style={{ fontSize: 12 }}>objects of that class in frame</span>
        </div>
      ) : null}

      {(rule.kind === "object_entered_zone" || rule.kind === "object_physically_entered_zone") ? (
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 13 }}>
            Zone{" "}
            <select value={rule.zoneId} onChange={(e) => onChange({ zoneId: e.target.value })}>
              {cfg.zones.length === 0 ? <option value="">No zones defined</option> : cfg.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 13 }}>
            Look-back window{" "}
            <input type="number" min={1} style={{ width: 64 }} value={rule.windowFrames} onChange={(e) => onChange({ windowFrames: Number(e.target.value) })} />
            {" "}frames
          </label>
          <span className="muted" style={{ fontSize: 12 }}>
            {rule.kind === "object_physically_entered_zone" ? "Fires when physical zone occupancy increased, ignoring priority" : "Fires when exclusive zone occupancy increased in the last N frames"}
          </span>
        </div>
      ) : null}

      {/* ── Change rules ── */}
      {rule.kind === "value_changed" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="row" style={{ alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 13 }}>OCR label <OcrLabelInput value={rule.ocrLabel} known={knownOcrLabels} onChange={(v) => onChange({ ocrLabel: v })} /></label>
            <label style={{ fontSize: 13 }}>
              Change type{" "}
              <select value={rule.changeOp} onChange={(e) => onChange({ changeOp: e.target.value as ChangeOpDraft })}>
                <option value="changed">changed (any difference)</option>
                <option value="unchanged">unchanged</option>
                <option value="increase">increased</option>
                <option value="decrease">decreased</option>
                <option value="delta_gt">increased by more than…</option>
                <option value="delta_lt">decreased by more than…</option>
                <option value="increase_lt">increased by less than…</option>
              </select>
            </label>
          </div>
          <div className="row" style={{ alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 13 }}>
              Compare against{" "}
              <input type="number" min={1} style={{ width: 64 }} value={rule.changeWindow} onChange={(e) => onChange({ changeWindow: Number(e.target.value) })} />
              {" "}frames ago
            </label>
            {(rule.changeOp === "delta_gt" || rule.changeOp === "delta_lt" || rule.changeOp === "increase_lt") ? (
              <label style={{ fontSize: 13 }}>
                Threshold{" "}
                <input type="number" style={{ width: 80 }} value={rule.changeThreshold} onChange={(e) => onChange({ changeThreshold: Number(e.target.value) })} />
              </label>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* ── Page rules ── */}
      {rule.kind === "page_active" ? (
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 13 }}>
            Page{" "}
            <select value={rule.pageId} onChange={(e) => onChange({ pageId: e.target.value })}>
              {cfg.pages.length === 0 ? <option value="">No pages defined</option> : cfg.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <span className="muted" style={{ fontSize: 12 }}>Passes when this page is the active screen</span>
        </div>
      ) : null}

      {rule.kind === "page_transition" ? (
        <div className="row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <label style={{ fontSize: 13 }}>
            From page{" "}
            <select value={rule.fromPageId} onChange={(e) => onChange({ fromPageId: e.target.value })}>
              <option value="">Any</option>
              {cfg.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <span style={{ fontSize: 13, color: "#6b7385" }}>→</span>
          <label style={{ fontSize: 13 }}>
            To page{" "}
            <select value={rule.toPageId} onChange={(e) => onChange({ toPageId: e.target.value })}>
              <option value="">Any</option>
              {cfg.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 13 }}>
            Within{" "}
            <input type="number" min={1} style={{ width: 64 }} value={rule.windowFrames} onChange={(e) => onChange({ windowFrames: Number(e.target.value) })} />
            {" "}frames
          </label>
        </div>
      ) : null}
    </div>
  );
}

// ─── Temporal diagram ─────────────────────────────────────────────────────────────

function TemporalDiagram({ rules }: { rules: RuleDraft[] }) {
  if (rules.length <= 1 && (rules[0]?.frameOffset ?? 0) === 0) return null;
  const offsets = rules.map((r) => r.frameOffset);
  const minOffset = Math.min(...offsets);
  const maxOffset = Math.max(...offsets);
  const span = Math.max(1, maxOffset - minOffset);

  return (
    <div style={{ background: "rgba(76,141,255,0.07)", border: "1px solid rgba(76,141,255,0.2)", borderRadius: 6, padding: "10px 14px", fontSize: 12 }}>
      <div style={{ fontWeight: 600, color: "#c8d0e0", marginBottom: 6 }}>Temporal alignment</div>
      <div style={{ position: "relative", height: rules.length * 24 + 18 }}>
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 1, background: "#2a2f3a" }} />
        <div style={{ position: "absolute", bottom: -4, right: 0, width: 2, height: "100%", background: "#4c8dff", opacity: 0.6 }} />
        <div style={{ position: "absolute", bottom: 6, right: 4, color: "#4c8dff", fontSize: 11, fontWeight: 600 }}>F (fires)</div>
        {rules.map((r, i) => {
          const pct = span === 0 ? 90 : ((r.frameOffset - minOffset) / span) * 85 + 5;
          const label = r.frameOffset === 0 ? "F" : r.frameOffset < 0 ? `F${r.frameOffset}` : `F+${r.frameOffset}`;
          return (
            <div key={r.id} style={{ position: "absolute", bottom: i * 24 + 10, left: `${pct}%`, display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: KIND_META[r.kind].color, flexShrink: 0 }} />
              <span style={{ color: "#c8d0e0", whiteSpace: "nowrap", fontSize: 11 }}>Rule {i + 1} @ {label} — {KIND_META[r.kind].label}</span>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 4, color: "#6b7385", fontSize: 11 }}>Event fires at F when every rule passes at its designated frame.</div>
    </div>
  );
}

// ─── Event editor (shared: create + edit) ────────────────────────────────────────

type EventEditorProps = {
  draft: EventDraft;
  cfg: ClassificationConfig;
  knownOcrLabels: string[];
  liveMatch: boolean | null;
  showAdvanced: boolean;
  jsonText: string;
  jsonError: string | null;
  onDraftChange: (d: EventDraft) => void;
  onJsonTextChange: (t: string) => void;
  onToggleAdvanced: () => void;
  onSubmit: () => void;
  onCancel?: () => void;
  submitLabel: string;
};

function EventEditor({
  draft, cfg, knownOcrLabels, liveMatch, showAdvanced, jsonText, jsonError,
  onDraftChange, onJsonTextChange, onToggleAdvanced, onSubmit, onCancel, submitLabel,
}: EventEditorProps) {
  const setDraft = onDraftChange;

  const updateRule = (i: number, patch: Partial<RuleDraft>) =>
    setDraft({ ...draft, rules: draft.rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });

  const addRule = () => setDraft({ ...draft, rules: [...draft.rules, defaultRuleDraft(cfg)] });

  const removeRule = (i: number) => setDraft({ ...draft, rules: draft.rules.filter((_, idx) => idx !== i) });

  const matchBadge = liveMatch === null
    ? { label: "—", color: "#6b7385", bg: "transparent", border: "#6b7385" }
    : liveMatch
      ? { label: "WOULD FIRE", color: "#12b76a", bg: "rgba(18,183,106,0.1)", border: "#12b76a" }
      : { label: "would not fire", color: "#9aa3b2", bg: "transparent", border: "#2a2f3a" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Event-level settings + live badge */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <label style={{ fontSize: 13 }}>Name <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={{ minWidth: 140 }} /></label>
            <label style={{ fontSize: 13 }}>ID <input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} style={{ minWidth: 120 }} /></label>
            <label style={{ fontSize: 13 }}>Priority <input type="number" style={{ width: 60 }} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} /></label>
          </div>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <label style={{ fontSize: 13 }}>
              Cooldown{" "}
              <input type="number" min={0} style={{ width: 72 }} value={draft.cooldown_frames} onChange={(e) => setDraft({ ...draft, cooldown_frames: Number(e.target.value) })} />
              <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>frames between firings</span>
            </label>
            <label style={{ fontSize: 13 }}>
              Dedupe window{" "}
              <input type="number" min={0} style={{ width: 64 }} value={draft.dedupe_merge} onChange={(e) => setDraft({ ...draft, dedupe_merge: Number(e.target.value) })} />
              <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>merge nearby firings</span>
            </label>
          </div>
        </div>
        {/* Live match badge */}
        <div style={{ padding: "6px 14px", borderRadius: 20, border: `1px solid ${matchBadge.border}`, background: matchBadge.bg, color: matchBadge.color, fontSize: 12, fontWeight: 600, letterSpacing: "0.04em", whiteSpace: "nowrap", alignSelf: "center" }}>
          Current frame: {matchBadge.label}
        </div>
      </div>

      {/* Advanced toggle */}
      <div className="row" style={{ alignItems: "center" }}>
        <button type="button" onClick={onToggleAdvanced} style={{ fontSize: 12, padding: "3px 10px" }}>
          {showAdvanced ? "◀ Visual builder" : "Advanced (JSON) ▶"}
        </button>
        {!showAdvanced && draft.rules.length === 0 ? (
          <span className="muted" style={{ fontSize: 12 }}>Add at least one rule before saving.</span>
        ) : null}
      </div>

      {/* ── Visual builder ── */}
      {!showAdvanced ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#c8d0e0" }}>Rules ({draft.rules.length})</span>
            <button type="button" onClick={addRule} style={{ fontSize: 12 }}>+ Add rule</button>
          </div>

          {draft.rules.length === 0 ? (
            <div style={{ padding: "20px", textAlign: "center", border: "1px dashed #2a2f3a", borderRadius: 6, color: "#6b7385", fontSize: 13 }}>
              No rules yet — the event will never fire.<br />
              <span style={{ fontSize: 12 }}>Click "+ Add rule" to define when this event occurs.</span>
            </div>
          ) : null}

          {draft.rules.map((rule, i) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              index={i}
              total={draft.rules.length}
              cfg={cfg}
              knownOcrLabels={knownOcrLabels}
              onChange={(patch) => updateRule(i, patch)}
              onRemove={() => removeRule(i)}
            />
          ))}

          {draft.rules.length > 0 ? <TemporalDiagram rules={draft.rules} /> : null}
        </div>
      ) : null}

      {/* ── JSON editor ── */}
      {showAdvanced ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="muted" style={{ fontSize: 12 }}>Edit the predicate as JSON. Supports all predicate kinds: comparison, logical, exists, change, transition, temporal, aggregate.</div>
          {jsonError ? <div style={{ color: "#ff8f8f", fontSize: 12, padding: "6px 10px", background: "rgba(255,80,80,0.08)", borderRadius: 4 }}>{jsonError}</div> : null}
          <textarea
            style={{ width: "100%", minHeight: 220, background: "#0b0d12", color: "#e8eaed", border: "1px solid #2a2f3a", fontFamily: "monospace", fontSize: 12, padding: 8 }}
            value={jsonText}
            onChange={(e) => onJsonTextChange(e.target.value)}
          />
        </div>
      ) : null}

      {/* Action buttons */}
      <div className="row" style={{ marginTop: 4 }}>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!showAdvanced && draft.rules.length === 0}
          style={{ background: "#1a2a4a", borderColor: "#4c8dff", color: "#4c8dff" }}
        >
          {submitLabel}
        </button>
        {onCancel ? <button type="button" onClick={onCancel}>Cancel</button> : null}
        {draft.rules.length > 1 && !showAdvanced ? (
          <span className="muted" style={{ fontSize: 12 }}>
            Fires when all {draft.rules.length} rules pass simultaneously at their respective offsets.
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────────

export function EventBuilderEditor() {
  const { state, dispatch, frameState, predicateStatus } = useProject();
  const cfg = state.config;

  // ── Create draft ──
  const [createDraft, setCreateDraft] = useState<EventDraft>(() => defaultEventDraft(cfg));
  const [createAdvanced, setCreateAdvanced] = useState(false);
  const [createJson, setCreateJson] = useState(() => JSON.stringify(buildEventPredicate(defaultEventDraft(cfg)), null, 2));
  const [createJsonError, setCreateJsonError] = useState<string | null>(null);

  // ── Edit state ──
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EventDraft | null>(null);
  const [editAdvanced, setEditAdvanced] = useState(false);
  const [editJson, setEditJson] = useState("");
  const [editJsonError, setEditJsonError] = useState<string | null>(null);
  const [editTooComplex, setEditTooComplex] = useState(false);

  const knownOcrLabels = useMemo(() => Object.keys(frameState.ocr_by_label).sort(), [frameState.ocr_by_label]);

  const applyConfig = (next: ClassificationConfig) => {
    const parsed = classificationConfigSchema.parse(next);
    dispatch({ type: "update_config", config: parsed });
  };

  // ── Live preview for create ──
  const createLiveMatch = useMemo(() => {
    if (createDraft.rules.length === 0) return null;
    try {
      const pred = createAdvanced ? predicateNodeSchema.parse(JSON.parse(createJson) as unknown) : buildEventPredicate(createDraft);
      const results = predicateStatus([{ id: "__preview__", name: "", priority: 0, predicate: pred }]);
      return results[0]?.satisfied ?? null;
    } catch { return null; }
  }, [createDraft, createAdvanced, createJson, predicateStatus]);

  // ── Live preview for edit ──
  const editLiveMatch = useMemo(() => {
    if (!editDraft) return null;
    try {
      const pred = editAdvanced ? predicateNodeSchema.parse(JSON.parse(editJson) as unknown) : buildEventPredicate(editDraft);
      const results = predicateStatus([{ id: "__preview__", name: "", priority: 0, predicate: pred }]);
      return results[0]?.satisfied ?? null;
    } catch { return null; }
  }, [editDraft, editAdvanced, editJson, predicateStatus]);

  // ── Open event for editing ──
  const openEdit = (ev: EventDefinition) => {
    const rules = tryParseEventPredicate(ev.predicate, cfg);
    const draft: EventDraft = {
      id: ev.id,
      name: ev.name,
      priority: ev.priority,
      cooldown_frames: ev.cooldown_frames ?? 0,
      dedupe_merge: ev.dedupe?.merge_adjacent_frames ?? 3,
      rules: rules ?? [],
    };
    setEditDraft(draft);
    setEditId(ev.id);
    setEditJson(JSON.stringify(ev.predicate, null, 2));
    setEditJsonError(null);
    const complex = rules === null;
    setEditTooComplex(complex);
    setEditAdvanced(complex);
  };

  // Keep editDraft in sync if cfg changes externally (e.g. zone deleted)
  useEffect(() => {
    if (!editId) return;
    const ev = cfg.events.find((e) => e.id === editId);
    if (!ev) { setEditId(null); setEditDraft(null); }
  }, [cfg.events, editId]);

  // ── Create handler ──
  const handleCreate = () => {
    if (!createAdvanced && createDraft.rules.length === 0) return;
    let predicate: PredicateNode;
    if (createAdvanced) {
      try {
        predicate = predicateNodeSchema.parse(JSON.parse(createJson) as unknown);
        setCreateJsonError(null);
      } catch (e) {
        setCreateJsonError(e instanceof Error ? e.message : String(e));
        return;
      }
    } else {
      predicate = buildEventPredicate(createDraft);
    }
    const event: EventDefinition = {
      id: createDraft.id.trim() || newId("ev"),
      name: createDraft.name.trim() || "New event",
      priority: Math.floor(createDraft.priority),
      predicate,
      cooldown_frames: Math.max(0, Math.floor(createDraft.cooldown_frames)),
      dedupe: { merge_adjacent_frames: Math.max(0, Math.floor(createDraft.dedupe_merge)), strategy: "leading_edge" },
    };
    applyConfig({ ...cfg, events: [...cfg.events, event] });
    const next = defaultEventDraft(cfg);
    setCreateDraft(next);
    setCreateJson(JSON.stringify(buildEventPredicate(next), null, 2));
    setCreateAdvanced(false);
    setCreateJsonError(null);
    dispatch({ type: "set_error", message: null });
    openEdit(event);
  };

  // ── Save edit handler ──
  const handleSaveEdit = () => {
    if (!editDraft || !editId) return;
    let predicate: PredicateNode;
    if (editAdvanced) {
      try {
        predicate = predicateNodeSchema.parse(JSON.parse(editJson) as unknown);
        setEditJsonError(null);
      } catch (e) {
        setEditJsonError(e instanceof Error ? e.message : String(e));
        return;
      }
    } else {
      if (editDraft.rules.length === 0) return;
      predicate = buildEventPredicate(editDraft);
    }
    const updated: EventDefinition = {
      id: editDraft.id.trim() || editId,
      name: editDraft.name.trim() || "Event",
      priority: Math.floor(editDraft.priority),
      predicate,
      cooldown_frames: Math.max(0, Math.floor(editDraft.cooldown_frames)),
      dedupe: { merge_adjacent_frames: Math.max(0, Math.floor(editDraft.dedupe_merge)), strategy: "leading_edge" },
    };
    applyConfig({ ...cfg, events: cfg.events.map((e) => (e.id === editId ? updated : e)) });
    dispatch({ type: "set_error", message: null });
  };

  const handleDelete = (id: string) => {
    applyConfig({ ...cfg, events: cfg.events.filter((e) => e.id !== id) });
    if (editId === id) { setEditId(null); setEditDraft(null); }
  };

  const handleToggleCreateAdvanced = () => {
    if (!createAdvanced) setCreateJson(JSON.stringify(buildEventPredicate(createDraft), null, 2));
    else {
      try {
        const pred = predicateNodeSchema.parse(JSON.parse(createJson) as unknown);
        const rules = tryParseEventPredicate(pred, cfg);
        if (rules) setCreateDraft((d) => ({ ...d, rules }));
      } catch { /* stay in advanced */ }
    }
    setCreateAdvanced((v) => !v);
    setCreateJsonError(null);
  };

  const handleToggleEditAdvanced = () => {
    if (!editAdvanced && editDraft) setEditJson(JSON.stringify(buildEventPredicate(editDraft), null, 2));
    else {
      try {
        const pred = predicateNodeSchema.parse(JSON.parse(editJson) as unknown);
        const rules = tryParseEventPredicate(pred, cfg);
        if (rules && editDraft) setEditDraft({ ...editDraft, rules });
      } catch { /* stay in advanced */ }
    }
    setEditAdvanced((v) => !v);
    setEditJsonError(null);
  };

  // ── Summary for event table ──
  function predicateSummary(p: PredicateNode): string {
    if (p.kind === "logical") return `${p.op.toUpperCase()} (${p.children.length} rules)`;
    if (p.kind === "temporal") return `temporal @${(p as Extract<PredicateNode, { kind: "temporal" }>).offset_frames}f`;
    if (p.kind === "comparison") return `compare`;
    if (p.kind === "change") return `change`;
    if (p.kind === "transition") return `transition`;
    return p.kind;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1000 }}>
      <p className="muted">
        Events fire when their rules are satisfied. Rules can be offset in time — e.g. rule A at the current frame AND rule B 10 frames earlier.
      </p>

      {/* ── Create ── */}
      <section style={{ border: "1px solid #2a2f3a", borderRadius: 6, padding: 14 }}>
        <h4 style={{ margin: "0 0 12px" }}>Create new event</h4>
        <EventEditor
          draft={createDraft}
          cfg={cfg}
          knownOcrLabels={knownOcrLabels}
          liveMatch={createLiveMatch}
          showAdvanced={createAdvanced}
          jsonText={createJson}
          jsonError={createJsonError}
          onDraftChange={setCreateDraft}
          onJsonTextChange={(t) => { setCreateJson(t); setCreateJsonError(null); }}
          onToggleAdvanced={handleToggleCreateAdvanced}
          onSubmit={handleCreate}
          submitLabel="Add event"
        />
      </section>

      {/* ── Existing events ── */}
      <section style={{ border: "1px solid #2a2f3a", borderRadius: 6, padding: 14 }}>
        <h4 style={{ margin: "0 0 10px" }}>Events ({cfg.events.length})</h4>
        {cfg.events.length === 0 ? <div className="muted">No events yet. Create one above.</div> : null}

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {cfg.events.map((ev) => {
            const isEditing = editId === ev.id;
            const fired = predicateStatus([ev])[0]?.satisfied ?? false;
            return (
              <div key={ev.id} style={{ border: isEditing ? "1px solid #4c8dff" : "1px solid #2a2f3a", borderRadius: 6, overflow: "hidden" }}>
                {/* Summary row */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: isEditing ? "#0d1a30" : "#0b0d12", flexWrap: "wrap" }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: fired ? "#12b76a" : "#2a2f3a", flexShrink: 0 }} title={fired ? "Firing at current frame" : "Not firing"} />
                  <strong style={{ fontSize: 14 }}>{ev.name}</strong>
                  <code style={{ fontSize: 11, color: "#9aa3b2" }}>{ev.id}</code>
                  <span className="muted" style={{ fontSize: 12 }}>pri {ev.priority} · cooldown {ev.cooldown_frames ?? 0} · {predicateSummary(ev.predicate)}</span>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    <button type="button" onClick={() => isEditing ? (setEditId(null), setEditDraft(null)) : openEdit(ev)} style={{ fontSize: 12 }}>
                      {isEditing ? "Close" : "Edit"}
                    </button>
                    <button type="button" onClick={() => handleDelete(ev.id)} style={{ fontSize: 12 }}>Delete</button>
                  </div>
                </div>

                {/* Inline editor */}
                {isEditing && editDraft ? (
                  <div style={{ padding: 14, borderTop: "1px solid #2a2f3a" }}>
                    {editTooComplex && !editAdvanced ? (
                      <div style={{ marginBottom: 8, fontSize: 12, color: "#f59e0b" }}>
                        ⚠ This predicate is too complex to show visually. Use Advanced (JSON) mode to edit it.
                      </div>
                    ) : null}
                    <EventEditor
                      draft={editDraft}
                      cfg={cfg}
                      knownOcrLabels={knownOcrLabels}
                      liveMatch={editLiveMatch}
                      showAdvanced={editAdvanced}
                      jsonText={editJson}
                      jsonError={editJsonError}
                      onDraftChange={setEditDraft}
                      onJsonTextChange={(t) => { setEditJson(t); setEditJsonError(null); }}
                      onToggleAdvanced={handleToggleEditAdvanced}
                      onSubmit={handleSaveEdit}
                      onCancel={() => { setEditId(null); setEditDraft(null); }}
                      submitLabel="Save changes"
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
