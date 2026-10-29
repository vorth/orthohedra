# Orthohedra (cubes-editor)

A web app for exploring **orthogonal polyhedra** — shapes assembled from unit cubes. Requirements largely come from mathematician David Richter. The interesting cases reproduce the topology of Archimedean solids (e.g. the great rhombicosidodecahedron).

## Architecture

- **Zero build step.** No `package.json`, no framework, no bundler. Plain static files served directly. Three.js is loaded from `esm.sh` via bare ES module imports (currently `three@0.172.0`).
- **Served via VS Code Live Server** on `http://localhost:5501` (see `.vscode/`).
- Files: `index.html` and `styles.css` at the root; all JavaScript lives in `js/`. `js/main.js` is still the bulk of the app (model state, modes, undo/redo glue, drag state machines, load/apply, DOM wiring); alongside it are `js/sceneRenderer.js` (three.js scene, camera/controls, InstancedMeshes, face visibility — a one-way rendering sink), `js/persistence.js` (save format, validation, legacy migrations), `js/faceColoring.js` (pure geometry for custom face colors), `js/constants.js`, `js/faceGeometry.js` (pure face-drag geometry — the interference rule), `js/realization.js` (abstract-realization worker lifecycle), `js/brinkSkeleton.js`, `js/realizeSkeleton.js`, and `js/realizeWorker.js` (the Web Worker itself). `main.js`/`styles.css` were originally inline in `index.html` and extracted later; `main.js` is being progressively split further (see `module-split-notes.md`).
- Module paths are all `./`-relative between siblings in `js/`, and `realization.js` spawns the worker via `new URL('./realizeWorker.js', import.meta.url)` — so the JS files must stay in one directory together. The `?design=` query parameter resolves against `window.location.href` instead, so relative design URLs stay page-relative (e.g. `designs/foo.json`).

## The source of truth

The **graph** is the source of truth: `currentSkeleton` in `main.js` — the brink skeleton `{vertices, edges, faces}` plus its identity keys (`byFaceKey`, etc., from `keySkeleton`). It is an abstract graph (edges + faces) together with a **drawing** of it (vertex coordinates). This is what gets saved, what undo/redo snapshots, and what `faceColors` is keyed against.

`positions` (an array of `{x, y, z}` integer cube coordinates) plus its `occupied` lookup Map are an **in-memory cube cache derived from the drawing** via `fillCubesFromSkeleton(skeleton)`. They back rendering, picking, and export, but they are not saved and are not authoritative.

How each path keeps the two in sync:
- **Load / restore / undo / redo:** fill `positions` from the skeleton, then `adoptSkeleton(skeleton)` with that skeleton's *own* vertices/edges/faces. Do **not** re-derive via `computeBrinkSkeleton(positions)` — its lexicographic vertex sort generally produces different face keys, which silently drops saved face colors. (Only "Load Abstract", whose coordinates are freshly realized, recomputes.)
- **Graph mode (Gp) edits** rewrite vertex coordinates on the existing graph (`applySwapStep`) and carry edge/face identity forward by reference; never re-derive the graph there.
- **Cubes mode (Gb) edits** are the one place cubes lead: the user sweeps cubes in/out, then the graph is re-derived with `computeBrinkSkeleton(positions)` and adopted. `updateBrinkSkeleton()` is this graph-*breaking* path.
- `adoptSkeleton(skeleton)` sets `currentSkeleton` and re-renders: skeleton spheres/cylinders, the metrics table, and boundary cube faces (`computeBoundaryCubeFaces(positions)`, per-axis quads). It never derives the graph and never records an edit; callers push edits via `recordSkeletonEdit`.

When adding new derived state, derive it fresh from `currentSkeleton` (or from `positions` for purely cube-level things like boundary squares). Don't patch derived state incrementally.

## Conventions

- **Axis → color: X = red, Y = yellow, Z = blue.** This mapping is shared by skeleton edges, boundary-cube faces, and the giant boundary cube. Face tints are those colors lightened toward white.
- **Face rendering is tri-state per axis:** clicking a giant-boundary-cube face cycles that axis's small-cube-face visibility solid → translucent → hidden. Translucent faces need `depthWrite=false` and a later `renderOrder` so opaque geometry behind them isn't wrongly occluded. Hidden faces must also be non-clickable (raycast should pass through to interior faces).
- **Persistence goes through `<design-app>`**, which provides autosave (key `cubes-editor:state`), Save/Open, and undo/redo. Autosave and saved files share one JSON shape (`serialize` in `js/persistence.js`): `skeleton` (`vertices`, `edges`, `faces`), `faceVisibility`, `faceColors`, `camera`. Cubes are **not** saved. Legacy files that carry only `positions` (or `renderMode`) still load and are migrated by `parseSavedState`.

## Performance — bulk edits MUST batch

Recomputing the skeleton (`computeBrinkSkeleton`) and adopting it (`adoptSkeleton`, which rebuilds every InstancedMesh) is whole-model work. Doing that per-cube in a loop is O(N²) + N redundant renders — it hangs and crashes the page on large models (a Klein-quartic abstract skeleton realizes to ~37k cubes).

- Any bulk voxel change (load, restore, undo/redo, reset, a Cubes-mode drag) must use the raw primitives `addVoxelRaw`/`removeVoxelRaw` and then adopt a skeleton **exactly once** at the end (`adoptSkeleton`, or `updateBrinkSkeleton()` on the graph-breaking path).
- Render loops building InstancedMesh matrices must reuse hoisted `THREE.Vector3` temporaries, not allocate per-instance.
- The realize+fill for "Load Abstract" runs in a worker and is fast (~30ms even for a 336-vertex skeleton). The crash was never in realize/fill, only in the per-cube apply loop.

## Working style (how I like to collaborate)

- **The user tests manually in the browser.** Do NOT launch dev servers, browser automation, or self-testing harnesses for visual changes — the user has Live Server running and judges results by eye. (Numeric/topological results with a definite right answer, e.g. Euler characteristic, are a possible exception.)
- **Prefer simple, decomposed algorithms** — parity- and dimension-based rules over orientation/winding tricks. When the math is exploratory, walk through the approach in prose/pseudocode and get agreement before writing code.
- The user commits deliberately and frequently. Running `/code-review` before a commit is welcome.
