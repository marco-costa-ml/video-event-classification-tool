import type { TimelineEvent } from "@/schemas/labels";
import { collapseAdjacentByName } from "@/domain/eventDedupe";

export type WasmEngineModule = {
  dedupeEventsJson: (json: string, mergeWindow: number) => string;
  /** Evaluates predicates against the JSON state root (same shape as `FrameState["value_root"]`). */
  evalPredicateJson: (stateJson: string, predicateJson: string) => number;
  version: () => string;
};

let cached: WasmEngineModule | null | undefined;

type EmscriptenFactory = (opts?: { locateFile?: (p: string) => string }) => Promise<WasmEngineModule>;

/**
 * Vite cannot `import()` JS that lives under `/public` (those files are not part of the module graph).
 * Load the Emscripten glue script via fetch → blob URL → dynamic import, and keep `.wasm` on `/wasm/`.
 */
async function loadEmscriptenModuleFromPublic(
  scriptPath: string,
  instantiate: (factory: EmscriptenFactory) => Promise<WasmEngineModule>,
): Promise<WasmEngineModule> {
  const res = await fetch(scriptPath, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`${scriptPath} HTTP ${res.status}`);
  const text = await res.text();
  const blob = new Blob([text], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const mod = (await import(/* @vite-ignore */ blobUrl)) as { default: EmscriptenFactory };
    return await instantiate(mod.default);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/**
 * Loads the Emscripten module from `/wasm/tec_engine.js` (built into `public/wasm`).
 * Returns null if the module is missing, which is expected before `npm run wasm:build`.
 */
export async function tryLoadWasmEngine(): Promise<WasmEngineModule | null> {
  if (cached !== undefined) return cached;
  try {
    const base = import.meta.env.BASE_URL;
    const instance = await loadEmscriptenModuleFromPublic(`${base}wasm/tec_engine.js`, (factory) =>
      factory({
        locateFile: (p: string) => `${base}wasm/${p}`,
      }),
    );
    cached = instance;
    return instance;
  } catch {
    cached = null;
    return null;
  }
}

export async function dedupeEventsViaWasm(events: TimelineEvent[], mergeWindow: number): Promise<TimelineEvent[]> {
  const wasm = await tryLoadWasmEngine();
  if (!wasm) return collapseAdjacentByName(events, mergeWindow);
  const out = wasm.dedupeEventsJson(JSON.stringify(events), mergeWindow);
  return JSON.parse(out) as TimelineEvent[];
}

export async function evalPredicateViaWasm(stateRootJson: string, predicateJson: string): Promise<boolean | null> {
  const wasm = await tryLoadWasmEngine();
  if (!wasm) return null;
  return wasm.evalPredicateJson(stateRootJson, predicateJson) !== 0;
}
