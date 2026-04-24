# Video Event Classification Tool (prototype)

Browser-based tool for defining, debugging, labeling, and evaluating sparse OCR + object-detection events over long videos. Core requirements: **indexed sparse timelines**, **generic predicates**, **manual labels**, **evaluation**, and a **C++/WebAssembly** performance path (with a full **TypeScript** implementation for correctness and tests).

## Quick start

1. Install Node.js 20+ (npm included).
2. From the repository root:

```bash
npm install
npm run dev
```

3. Open the printed local URL. The app boots with an in-memory sample project (OCR + objects + config).

### Tests

```bash
npm test
```

### WebAssembly engine (optional, recommended for portfolio demos)

The UI runs fully without WASM (TypeScript engine). To build the Emscripten module into `public/wasm/`:

```bash
# Install/activate Emscripten SDK, then:
emcmake cmake -B wasm/build -S wasm -DCMAKE_BUILD_TYPE=Release
cmake --build wasm/build
```

Outputs `public/wasm/tec_engine.js` + `tec_engine.wasm`. The React app loads the glue script with `fetch` + a blob URL + dynamic `import()` (Vite does not allow bundling `import("/wasm/*.js")` from `/public`). It falls back silently if the files are missing.

## Project structure (proposed)

```
src/
  schemas/            # Zod schemas = runtime validation + TS types
  domain/             # Sparse index, frame reconstruction, predicates, events
  evaluation/         # Matching + metrics (manual vs predicted)
  services/           # Parquet ingest, exports, WASM bridge
  store/              # Pure reducer (domain transitions)
  context/            # React provider wiring async IO to reducer
  ui/                 # Presentational components (canvas/video separated)
  data/               # Built-in sample slices + config
  __tests__/          # Vitest unit tests
wasm/
  CMakeLists.txt
  bindings.cpp        # Embind exports (dedupe + subset predicate eval)
public/wasm/          # Emscripten build output (gitignored except README)
data/samples/         # Example JSON configs for import
```

## Architecture summary

- **Sparse ingestion**: Parquet rows are read with `hyparquet`, sorted and **merged per frame** into `LoadedParquetSlice` (`frames[]` + `rows[][]`). No full densification across the whole timeline. Column names are **auto-inferred** when they do not match the JSON map (common for exports like `composed_state.parquet` / `rec_stable.parquet`): alternate frame keys (`frame_idx`, …), corner boxes (`x1,y1,x2,y2`), nested `bbox` objects, and `BigInt` frame indices.
- **Timeline length & resolution**: After OCR/objects parquet loads or video metadata loads, `frame_count` is set to `max(config, parquet_max_frame+1, ceil(duration*fps))`. Video `loadedmetadata` updates **native width/height** used for drawing (defaults in sample configs are **640×360** when no video is loaded).
- **Visualizer**: The canvas and `<video>` use the same pixel dimensions as `config.video` (native / config space) so zone and bbox coordinates align with the top-left of the frame.
- **Indexing**: `SparseIndex` maps a frame to a contiguous row span for OCR/objects (`FrameRowRangeIndex`).
- **State reconstruction**: `createFrameStateCache` materializes `FrameState` for a frame with LRU caching and **prefetch** around the playhead. Pages resolve with a deterministic **priority sort**; predicates evaluated during page matching must not depend on the resolved `page` field (it is `null` during matching).
- **Zones**: Objects are assigned to **at most one zone** by **highest priority** zone whose geometry contains the object center (`assignObjectsToZones`).
- **Predicates**: JSON-serializable AST (`PredicateNode`) evaluated in TypeScript (`predicateEval.ts`). WASM duplicates a **small subset** (`logical`, `comparison`, `exists`, `not_exists`) for speed experiments (`wasm/bindings.cpp`).
- **Events**: Each `EventDefinition` has a predicate tree, optional cooldown, and dedupe metadata. `runEventDetection` currently performs a **linear scan over `[0, frame_count)`** (acceptable for the bundled sample; next scaling step is sparse indexing of predicate truth intervals + windowed sweeps).
- **UI separation**: `projectReducer.ts` owns domain transitions; React components subscribe via `ProjectContext` and keep rendering concerns in `ui/*`.

## Data contract (Parquet columns)

Configured via `classification.json` → `parquet.ocr` / `parquet.objects` column maps:

| Role    | Required | Typical columns |
|---------|----------|-----------------|
| Shared  | `frame`  | Integer frame index |
| OCR     | optional | `label`, `text`, `x`, `y`, `w`, `h`, `confidence` |
| Objects | optional | `object_id`, `class`, `score`, `x`, `y`, `w`, `h` |

Missing frames are normal: `FrameState.missing` flags sparse gaps.

## JSON / TypeScript model

Authoritative types live in `src/schemas/*` (Zod). Highlights:

- `ClassificationConfig` (`classification.ts`)
- `PredicateNode`, `ValueExpr` (`predicates.ts`)
- `EventDefinition` (`events.ts`)
- `ZoneDefinition` (`zones.ts`)
- `PageDefinition` (`pages.ts`, field `match`)
- `TimelineEvent` (`labels.ts`) shared by manual + predicted exports

## C++/WebAssembly interface

Embind exports (see `wasm/bindings.cpp`):

- `dedupeEventsJson(json: string, mergeWindow: number): string`
- `evalPredicateJson(stateJson: string, predicateJson: string): number` (1/0; `stateJson` is the `FrameState.value_root` JSON)
- `version(): string`

TypeScript wrapper: `src/services/engineBridge.ts`.

## Sample files

- `data/samples/sample_classification.json` — same shape as the built-in sample (importable).
- `src/data/builtinSample.ts` — programmatic sample slices for first-run UX.

## Non-goals (v0)

- No backend server.
- No full timeline densification by default.
- Parquet **writing** from the browser is stubbed via JSONL export (`src/services/parquetExport.ts` documents the interchange contract).

## Troubleshooting

- **Parquet codec errors**: stock `hyparquet` supports Snappy + uncompressed. For gzip/zstd, add `hyparquet-compressors` (see hyparquet README).
- **Config validation errors**: all configs pass through `classificationConfigSchema.parse`.
