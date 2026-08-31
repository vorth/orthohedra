# Breaking up `main.js` — a proposal

## What's actually wrong

`main.js` is 1915 lines, but the line count isn't the problem. **Everything lives
inside one `async function main()` closure**, so every function can reach every
piece of state. There are no enforced boundaries — only conventions and section
comments. That's what makes it feel monolithic: you can't read one part without
holding the possibility that any other part mutates what you're looking at.

The good news, from measuring the call graph: **the layers are already nearly
separate in practice.** The closure hides that fact rather than causing it. Most
of this split is mechanical.

## The measurements that matter

I checked what each candidate block actually references:

| Block | Lines | References into the rest of the closure |
|---|---|---|
| Interference + drag geometry (490–838) | ~350 | `currentSkeleton` ×4, `boundaryFaceInfoByAxis` ×1, `MIN`/`MAX` — **and zero `THREE`** |
| Persistence + file I/O (842–1270) | ~430 | `positions` ×19, `camera` ×14, `faceVisibility` ×7, plus 4 callbacks |
| Rendering (139–479) | ~340 | `positions` ×2, `occupied` ×1, `saveToLocalStorage` ×1 |

Two conclusions:

- The **geometry layer is already pure** — no three.js, no rendering, no state.
  All six closure references sit inside a single function (`connectedFace`).
  This is the cleanest fracture line in the file by a wide margin.
- The **render layer is nearly a pure sink** — data in, GPU out. Its three stray
  references are incidental, not structural.

## Proposed modules

Five new files, all plain ES modules loaded exactly as `brinkSkeleton.js` is
today — no build step, no bundler, no framework. That constraint is preserved.

### 1. `faceGeometry.js` — do this one first, alone

Move `pointSegDist2`, `normalizeSeg`, `prepareFace`, `segmentsInterfere`,
`facesInterfere`, `projectFace`, `buildPlaneFaceIndex`, `computeAvailablePlanes`,
`dragBounds`, `applyGraphDrawingEdit`.

Every one is already a pure function of its arguments. Two small changes make the
module self-contained:

- `connectedFace` keeps its `boundaryFaceInfoByAxis`/`currentSkeleton` reads, so
  it **stays in `main.js`** — it's a picking concern, not geometry. It calls into
  the module.
- `computeAvailablePlanes` takes `MIN`/`MAX` as parameters (or imports them from
  a shared `constants.js`) instead of closing over them.

**Why first:** it's the only module extractable with zero behavior risk, and it's
the part with real algorithmic content worth testing in isolation. Right now the
interference predicate can only be exercised by clicking in a browser — as a
module it's directly unit-testable, which matters given the rule's boundary cases
(shared corner vs. T-junction vs. proper crossing) are exactly where a subtle
error would hide. I had to copy the functions into a scratch file to test them
during the last change; that shouldn't be necessary.

### 2. `constants.js`

`SIZE`, `HALF`, `MIN`, `MAX`, `AXIS_COLORS`, `FACE_COLORS`, `FACE_SOLID` /
`FACE_TRANSLUCENT` / `FACE_HIDDEN`, `STORAGE_KEY`, radii and linewidths. Tiny,
but it's what lets the other modules stop reaching into `main()`.

### 3. `renderer.js` — a `SceneRenderer` factory

Scene, camera, renderer, controls, lights, bounds box, all InstancedMesh holders
and materials, plus `renderBoundaryCubeFaces`, `renderBrinkSkeleton`,
`applyFaceVisibility`, `cycleFaceVisibility`, the outline/impeder/hover visuals,
and `getIntersection`.

This is the biggest block and the one that owns nearly all the three.js objects.
Export a factory returning `{ scene, camera, controls, renderSkeleton,
renderFaces, setFaceVisibility, pick, ... }`. Its three stray references become
arguments.

`faceVisibility` moves here — it's a rendering choice, and the codebase already
treats it that way (undo/redo deliberately excludes it).

### 4. `persistence.js`

`currentStateJSON`, `parseSavedState`, `saveToLocalStorage`,
`loadFromLocalStorage`, the File System Access save/load paths, `derivePositionsSync`,
`dropOutOfBounds`, `hasDrawing`, `loadFromDesignParam`.

This block has the highest coupling (19 `positions`, 14 `camera`), but the
coupling is **all reads of a snapshot**. Restructure as: `serialize(state)` takes
an explicit `{positions, skeleton, camera, faceVisibility}` object;
`deserialize(raw)` returns one. `main.js` gathers the snapshot and applies the
result. That inverts the dependency cleanly and is the single biggest readability
win in the file.

### 5. `realization.js`

The worker lifecycle: `realizeAbstract`, `teardownWorker`, `cancelRealization`,
`setBusy` and the busy overlay. Self-contained already; ~130 lines.

## What stays in `main.js`

Roughly 300–400 lines, and it should read as an orchestrator:

- `positions` / `occupied` and the voxel primitives — the source of truth stays put
- `adoptSkeleton` / `updateBrinkSkeleton` — **the hub**, see below
- undo/redo (`history`, `recordHistory`, `restoreHistory`)
- drag state machine (`startDrag`, `updateDrag`, `commitDrag`, `endDrag`)
- `connectedFace`, mode handling, DOM wiring, event listeners

## The one genuinely tangled spot

`adoptSkeleton` (line 1375) is where every layer meets:

```
recordHistory      → history
currentSkeleton =  → model state
renderBrinkSkeleton→ render
skeletonStatsEl    → DOM
renderBoundaryCubeFaces → render
saveToLocalStorage → persistence
```

Six concerns in fourteen lines. **This is correct and shouldn't be "fixed" by
hiding it** — it's the single choke point through which all state changes flow,
which is exactly the architecture CLAUDE.md describes ("recompute fresh from
`positions`, don't incrementally patch"). After the split it stays in `main.js`
and becomes the *visible* seam between modules, which is an improvement: the
coupling is currently real but invisible.

## Suggested order

1. `constants.js` + `faceGeometry.js` — mechanical, low risk, immediately useful
2. `realization.js` — self-contained
3. `persistence.js` — needs the serialize/deserialize inversion; most design work
4. `renderer.js` — largest, best done once the others have shrunk `main.js`

Each step leaves the app working and is independently committable. **I'd
recommend stopping after step 1 or 2 and testing**, since steps 3–4 involve
restructuring rather than moving.

## Honest caveats

- **Steps 3 and 4 are refactors, not moves.** They change how data flows
  (parameters instead of closure reads). That's where regressions would come
  from, and everything is verified by eye in the browser.
- **Module count is a real cost.** Five imports at the top of `main.js`, and
  "where does this live?" becomes a question it isn't today.
- **The closure isn't purely bad.** It gives zero-ceremony access to shared
  state, which is why the app got written quickly. Splitting trades that for
  enforced boundaries.
- If you only want one change: **do `faceGeometry.js` and stop.** It captures
  most of the benefit (testable algorithms, a real boundary) for the least risk.
