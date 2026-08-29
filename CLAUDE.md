# Orthohedra (cubes-editor)

A web app for exploring **orthogonal polyhedra** — shapes assembled from unit cubes. Requirements largely come from mathematician David Richter. The interesting cases reproduce the topology of Archimedean solids (e.g. the great rhombicosidodecahedron).

## Architecture

- **Zero build step.** No `package.json`, no framework, no bundler. Plain static files served directly. Three.js is loaded from `esm.sh` via bare ES module imports (currently `three@0.172.0`).
- **Served via VS Code Live Server** on `http://localhost:5501` (see `.vscode/`).
- Files: `index.html` and `styles.css` at the root; all JavaScript lives in `js/`. `js/main.js` is still the bulk of the app (scene, rendering, persistence, undo/redo, drag state machine, DOM wiring); alongside it are `js/constants.js`, `js/faceGeometry.js` (pure face-drag geometry — the interference rule), `js/realization.js` (abstract-realization worker lifecycle), `js/brinkSkeleton.js`, `js/realizeSkeleton.js`, and `js/realizeWorker.js` (the Web Worker itself). `main.js`/`styles.css` were originally inline in `index.html` and extracted later; `main.js` is being progressively split further (see `module-split-notes.md`).
- Module paths are all `./`-relative between siblings in `js/`, and `realization.js` spawns the worker via `new URL('./realizeWorker.js', import.meta.url)` — so the JS files must stay in one directory together. The `?design=` query parameter resolves against `window.location.href` instead, so relative design URLs stay page-relative (e.g. `designs/foo.json`).

## The source of truth

`positions` — an array of `{x, y, z}` integer cube-center coordinates — plus its `occupied` lookup Map, both in `main.js`, are the **sole source of truth**. *Every* other piece of state is recomputed from `positions`.

On each add/remove, `updateBrinkSkeleton()` recomputes everything:
- `computeBrinkSkeleton(positions)` → `{vertices, edges, faces}`, the **brink skeleton** mesh. Rendered as white spheres (vertices) + cylinders (edges).
- `computeBoundaryCubeFaces(positions)` → non-internal unit cube faces, rendered as per-axis quads.

When adding new derived-state features, follow this pattern: compute fresh from `positions`, don't incrementally patch derived state.

## Conventions

- **Axis → color: X = red, Y = yellow, Z = blue.** This mapping is shared by skeleton edges, boundary-cube faces, and the giant boundary cube. Face tints are those colors lightened toward white.
- **Face rendering is tri-state per axis:** clicking a giant-boundary-cube face cycles that axis's small-cube-face visibility solid → translucent → hidden. Translucent faces need `depthWrite=false` and a later `renderOrder` so opaque geometry behind them isn't wrongly occluded. Hidden faces must also be non-clickable (raycast should pass through to interior faces).
- **State persists to `localStorage`** (key `cubes-editor:state`) on every change; same JSON shape (`positions`, `renderMode`, `camera`) is used for explicit file save/load via the File System Access API (with a download/file-input fallback).

## Performance — bulk edits MUST batch

`addVoxel`/`removeVoxel` each call `updateBrinkSkeleton()`, which recomputes the whole skeleton, rebuilds every InstancedMesh, and writes localStorage. Doing that per-cube in a loop is O(N²) + N redundant renders — it hangs and crashes the page on large models (a Klein-quartic abstract skeleton realizes to ~37k cubes).

- Any bulk voxel change (notably `applyLoadedState`) must use the raw primitives `addVoxelRaw`/`removeVoxelRaw` and call `updateBrinkSkeleton()` **exactly once** at the end.
- Render loops building InstancedMesh matrices must reuse hoisted `THREE.Vector3` temporaries, not allocate per-instance.
- The realize+fill for "Load Abstract" runs in a worker and is fast (~30ms even for a 336-vertex skeleton). The crash was never in realize/fill, only in the per-cube apply loop.

## Working style (how I like to collaborate)

- **The user tests manually in the browser.** Do NOT launch dev servers, browser automation, or self-testing harnesses for visual changes — the user has Live Server running and judges results by eye. (Numeric/topological results with a definite right answer, e.g. Euler characteristic, are a possible exception.)
- **Prefer simple, decomposed algorithms** — parity- and dimension-based rules over orientation/winding tricks. When the math is exploratory, walk through the approach in prose/pseudocode and get agreement before writing code.
- The user commits deliberately and frequently. Running `/code-review` before a commit is welcome.
