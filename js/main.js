import { computeBrinkSkeleton, logBrinkSkeleton } from "./brinkSkeleton.js";
import { fillCubesFromSkeleton } from "./realizeSkeleton.js";
import { MIN, MAX, inBounds } from "./constants.js";
import {
  inPlaneAxes,
  pointSegDist2,
  prepareFace,
  projectFace,
  dragBounds,
  buildSwapPlaneIndex,
  planSwapStep,
  applySwapStep,
  updateSwapIndex,
  planeOfFace,
} from "./faceGeometry.js";
import { createRealizer } from "./realization.js";
import { serialize, parseSavedState, pickAndParseFile, loadFromDesignParam } from "./persistence.js";
import { createSceneRenderer } from "./sceneRenderer.js";

const app = document.querySelector('design-app');
const errorEl = document.getElementById('error');
const statusEl = document.getElementById('status');
const skeletonStatsEl = document.getElementById('skeletonStats');
const cubesBtn = document.getElementById('cubesBtn');
const graphBtn = document.getElementById('graphBtn');
const busyOverlay = document.getElementById('busyOverlay');
const cancelBusyBtn = document.getElementById('cancelBusyBtn');

await customElements.whenDefined('design-app');

async function main() {
  // All drawing lives in sceneRenderer.js; this is the only handle to it.
  const viewport = document.getElementById('viewport');
  const view = createSceneRenderer(viewport);
  const faceVisibility = view.faceVisibility;

  // --- Modes ---------------------------------------------------------------
  // Two modes, matching the Gp/Gb split (see project memory): "cubes" is
  // graph-breaking (Gb) — drag a boundary face to sweep cubes in or out, and
  // the graph is freely re-derived from the result. "graph" is
  // graph-preserving (Gp) — drag a boundary face along its normal axis to
  // slide it, and the drag surgically rewrites vertex coordinates on the
  // affected face cycles without ever touching edge/face identity. Both drags
  // grab only VISIBLE boundary faces — picking (getIntersection) already
  // filters to them, so hidden faces let the gesture fall through to the
  // trackball instead.
  //
  // Starts null (not 'cubes') so the first setMode() call in applyInitialState
  // always applies its visual side effects (button state, skeleton
  // visibility) instead of short-circuiting on an already-equal mode.
  let mode = null;
  let currentSkeleton = null; // cached { vertices, edges, faces } from updateBrinkSkeleton

  // Drag state for both modes, declared up front: setMode() (called from
  // applyInitialState() during startup, before either drag's own section
  // below runs) calls cancelGraphDrag()/cancelCubesDrag(), which read these —
  // declared this early so that first call doesn't hit the temporal dead zone.
  //
  // Graph-mode drag: { axis, face, dragged, index, limits, baseSkeleton,
  //   skeleton, steps, linePoint, dragValue }
  let drag = null;
  // A grabbed-but-trapped face (grabbable, but with no legal destination): the
  // gesture is consumed and its impeders shown, but there is no live drag.
  let trapped = false;
  // Cubes-mode drag: { cell, dir, facePoint, baseSkeleton, startX, startY, moved }
  let cubesDrag = null;

  // Identify the ONE brink-skeleton face (in the plane normal to the edit axis,
  // at the grabbed quad's coordinate) whose edges the grabbed quad is nearest.
  // Returns { coord, vertexIndices, segments }: the shared edit-axis coordinate,
  // the face's skeleton vertex indices (whose coordinate the drag shifts on
  // commit), and its edges as in-plane [au,av,bu,bv] segments (for the drag
  // visuals), or null if no bounding face was found.
  //
  // A single grid plane at one coord may hold SEVERAL disjoint brink-skeleton
  // face cycles — e.g. eight squares around an empty center give an outer ring
  // cycle and an inner hole cycle. By the parity construction (see
  // brinkSkeleton.js) these cycles never share an edge and touch only at
  // non-extremal points, so they are genuinely disjoint edge sets. We therefore
  // select by the ACTUAL click point: build the in-plane cycles, then pick the
  // one whose nearest edge is closest to where the ray met the grabbed quad,
  // rather than whichever the flood-fill happened to reach first.
  function connectedFace(axis, startId, hitPoint) {
    const faces = view.boundaryFaceInfo(axis);
    const coord = Math.round(faces[startId].center[axis]);
    const [ua, ub] = inPlaneAxes(axis);

    // In-plane click coordinates. Fall back to the grabbed quad's center if no
    // hit point was supplied.
    const hu = hitPoint ? hitPoint.getComponent(ua) : faces[startId].center[ua];
    const hv = hitPoint ? hitPoint.getComponent(ub) : faces[startId].center[ub];

    if (!currentSkeleton) return null;

    // The in-plane face cycles at this coord, each with the info the drag needs:
    // the skeleton vertex indices to shift on commit, and its edges as in-plane
    // [au,av,bu,bv] segments for the drag visuals.
    let best = null;
    let bestDist = Infinity;
    for (let faceIdx = 0; faceIdx < currentSkeleton.faces.length; faceIdx++) {
      const projected = projectFace(currentSkeleton, faceIdx, axis);
      if (!projected || projected.coord !== coord) continue;
      // Distance from the click point to this cycle = its nearest edge.
      let dist = Infinity;
      for (const [au, av, bu, bv] of projected.segments) {
        dist = Math.min(dist, pointSegDist2(hu, hv, au, av, bu, bv));
      }
      if (dist < bestDist) {
        bestDist = dist;
        // `key` names this face independently of index order, so the commit can
        // re-resolve it against a freshly computed skeleton instead of trusting
        // indices captured when the drag began.
        best = {
          coord,
          key: currentSkeleton.faceKeys[faceIdx],
          vertexIndices: projected.vertexIndices,
          segments: projected.segments,
        };
      }
    }

    return best; // null if no in-plane bounding face was found (shouldn't happen)
  }

  const occupied = new Map();
  const positions = [];

  // --- Undo/redo -----------------------------------------------------------
  // Undo/redo is <design-app>'s: every edit is pushed via app.edit({label,
  // redo, undo}), which owns the stack, the Undo/Redo UI, and their keyboard
  // shortcuts. Each edit's thunks close over the Graph Drawing (the skeleton)
  // before and after the change, which IS the model state — cubes are left out
  // because they are derived, and a redo/undo thunk refills them from the
  // drawing (~49ms even for the 37k-cube Klein quartic, imperceptible for an
  // undo). Face visibility and camera are never pushed as edits: they are
  // rendering choices, not model state, so an undo reverts your edit without
  // disturbing how you are looking at it.
  //
  // Whole-skeleton snapshots rather than per-operation inverses: the drawing is
  // small (3.9 KB for the largest design in designs/), and an inverse that is
  // subtly wrong corrupts state silently, which a snapshot cannot do.
  //
  // No deep copy is needed: every producer of a skeleton (computeBrinkSkeleton,
  // applySwapStep) returns a fresh object with a fresh vertices array,
  // and nothing mutates a skeleton in place.

  // Refill `positions` from a skeleton snapshot and adopt it as current — the
  // shared body of every edit's redo/undo thunk. Raw primitives plus one
  // adoptSkeleton, per the bulk-edit rule: a per-cube addVoxel loop here would
  // rebuild every InstancedMesh per cube.
  function restoreSkeleton(skeleton) {
    try {
      const cubes = dropOutOfBounds(fillCubesFromSkeleton(skeleton));
      for (const { x, y, z } of [...positions]) removeVoxelRaw(x, y, z);
      for (const { x, y, z } of cubes) addVoxelRaw(x, y, z);
    } catch (error) {
      console.error('Undo/redo failed while refilling cubes from the drawing:', error);
      updateBrinkSkeleton(); // cubes may be half-swapped: re-derive from them
      return;
    }
    adoptSkeleton(skeleton);
    updateStatus();
  }

  // Record a graph-level change (`from` -> `to`) as one undoable step.
  function recordSkeletonEdit(from, to, label, mergeKey = null) {
    app.edit({
      label,
      mergeKey,
      redo: () => restoreSkeleton(to),
      undo: () => restoreSkeleton(from),
    });
  }

  // --- Persistence glue ----------------------------------------------------
  // persistence.js owns the save FORMAT but knows nothing about this app's
  // state, so everything it writes comes through here. `snapshot()` gathers the
  // three things a save records; the skeleton is rebuilt from `positions`
  // rather than read from `currentSkeleton` so a save always reflects the
  // cubes, exactly as before the split.
  function snapshot() {
    return {
      skeleton: computeBrinkSkeleton(positions),
      faceVisibility,
      camera: view.getCameraState(),
    };
  }

  function applyLoadedState(state) {
    if (!state) return;

    // The graph BEFORE the load, for undo. Swap the whole voxel set in ONE
    // batch using the raw (non-recomputing) primitives, then recompute the
    // skeleton exactly once at the end. Using addVoxel/removeVoxel here would
    // recompute the brink skeleton and rebuild every instanced mesh on EACH
    // cube — O(N²) work plus N redundant renders — which hangs and crashes the
    // page on large models (e.g. a 37k-cube realized skeleton).
    const before = currentSkeleton ?? computeBrinkSkeleton(positions);
    for (const { x, y, z } of [...positions]) removeVoxelRaw(x, y, z);
    for (const { x, y, z } of state.positions) addVoxelRaw(x, y, z);
    const after = computeBrinkSkeleton(positions);
    recordSkeletonEdit(before, after, 'Load');
    adoptSkeleton(after);

    faceVisibility.splice(0, 3, ...state.faceVisibility);
    view.applyFaceVisibility();

    if (state.camera) {
      view.setCameraState(state.camera);
    }

    setMode('graph'); // a deliberate load/open always opens in Graph mode
  }

  // A saved file holds an abstract GRAPH (edges + faces) and, optionally, a
  // DRAWING of it (vertex coordinates). Cubes are a derivation, not content,
  // so a plain open resolves on what the file actually carries:
  //   graph + drawing -> fill cubes from the drawing (authoritative even when
  //                      legacy `positions` are also present)
  //   graph, no drawing -> realize coordinates, then fill
  //   positions only    -> legacy file: load the cubes directly
  // The explicit 'skeleton' and 'abstract' gestures remain as OVERRIDES —
  // loading a drawn graph *as* abstract, to re-realize its coordinates, is a
  // meaningful thing to ask for.
  //
  // Whatever the route, the applied `positions` become the in-memory cube
  // cache backing rendering, picking, and export; the app re-derives the
  // skeleton from them on load.
  const dropOutOfBounds = (cubes) => {
    const kept = cubes.filter((c) => inBounds(c.x, c.y, c.z));
    if (kept.length !== cubes.length) {
      console.warn(`Load: ${cubes.length - kept.length} recovered cube(s) fell outside bounds and were dropped.`);
    }
    return kept;
  };

  // Does this state carry a usable drawing (a graph with real coordinates)?
  const hasDrawing = (state) => Boolean(state.skeleton && state.skeleton.vertices.length);

  // Synchronous cube derivation for the 'cubes' and 'skeleton' gestures (both
  // fast). The 'abstract' gesture is handled separately via a worker because
  // its coordinate realization can be slow — see realizeAbstract().
  function derivePositionsSync(state, interpretation) {
    // A plain open prefers the drawing over any stored cubes: the drawing is
    // the content, the cubes a derivation of it. Old files carry both.
    if (interpretation === 'cubes') {
      if (!hasDrawing(state)) return state.positions;
      try {
        return dropOutOfBounds(fillCubesFromSkeleton(state.skeleton));
      } catch (error) {
        console.error('Load failed while filling cubes from the drawing:', error);
        return state.positions; // fall back to stored cubes if present
      }
    }
    if (!state.skeleton) {
      console.error(`Load failed: file has no skeleton to load as "${interpretation}".`);
      return null;
    }
    // The 'skeleton' gesture fills from real coordinates; an abstract-only
    // skeleton (a graph with a vertex count but no coordinate array) has none —
    // it can only be loaded via the 'abstract' gesture, which re-realizes them.
    if (!state.skeleton.vertices.length && state.skeleton.vertexCount > 0) {
      console.error('Load failed: skeleton has no vertex coordinates; use "Load Abstract" instead.');
      return null;
    }
    try {
      // 'skeleton' fills the file's concrete skeleton directly (exact
      // round-trip).
      const cubes = fillCubesFromSkeleton(state.skeleton);
      return dropOutOfBounds(cubes);
    } catch (error) {
      console.error(`Load failed while recovering cubes (${interpretation}):`, error);
      return null;
    }
  }

  // The abstract-realization worker (see realization.js). Owns the busy flag;
  // `busy` is read through realizer.isBusy() at the edit and keyboard guards.
  const realizer = createRealizer(busyOverlay);
  const { setBusy, realizeAbstract, cancelRealization } = realizer;

  async function applyLoadedFile(state, interpretation) {
    // A plain open of a file that carries a graph but NO drawing has to
    // realize coordinates first — the same work the explicit 'abstract'
    // gesture does, so route it there rather than failing for want of cubes.
    if (interpretation === 'cubes' && !hasDrawing(state) && state.skeleton?.vertexCount > 0 && !state.positions.length) {
      interpretation = 'abstract';
    }

    if (interpretation === 'abstract') {
      if (!state.skeleton) {
        console.error('Load failed: file has no skeleton to load as "abstract".');
        return;
      }
      console.warn(
        'Load Abstract is best-effort: coordinates are re-realized from the ' +
          'coordinate-free graph, recovering some solid with an isomorphic ' +
          'skeleton — not necessarily the original shape or pose.'
      );
      setBusy(true);
      try {
        const cubes = await realizeAbstract(state.skeleton);
        applyLoadedState({ ...state, positions: dropOutOfBounds(cubes) });
      } catch (error) {
        if (error?.message !== 'cancelled') {
          console.error('Load failed while realizing abstract skeleton:', error);
        }
      } finally {
        setBusy(false);
      }
      return;
    }

    const positions = derivePositionsSync(state, interpretation);
    if (!positions) return;
    applyLoadedState({ ...state, positions });
  }


  function key(x, y, z) {
    return `${x},${y},${z}`;
  }

  function hasVoxel(x, y, z) {
    return occupied.has(key(x, y, z));
  }

  function updateStatus() {
    const label = mode === 'cubes' ? 'Cubes' : 'Graph';
    statusEl.innerHTML = `Mode: ${label}<br>Cubes: ${positions.length}`;
  }

  // A graph is bipartite iff it has no odd-length cycle. 2-color each
  // connected component by BFS; a conflict (neighbor wants the same color)
  // means an odd cycle exists.
  function isBipartite(vertexCount, edges) {
    const adjacency = Array.from({ length: vertexCount }, () => []);
    for (const [a, b] of edges) {
      adjacency[a].push(b);
      adjacency[b].push(a);
    }
    const color = new Array(vertexCount).fill(-1);
    for (let start = 0; start < vertexCount; start++) {
      if (color[start] !== -1) continue;
      color[start] = 0;
      const queue = [start];
      while (queue.length > 0) {
        const v = queue.shift();
        for (const n of adjacency[v]) {
          if (color[n] === -1) {
            color[n] = 1 - color[v];
            queue.push(n);
          } else if (color[n] === color[v]) {
            return false;
          }
        }
      }
    }
    return true;
  }

  // Adopt an ALREADY-KNOWN skeleton as the current one: render it, restate the
  // topology readout, and rebuild the cube-face geometry. Deliberately does NOT
  // derive the graph — a graph-preserving edit already holds the graph, and
  // re-deriving it would be both wasteful and lossy (see applySwapStep). Never
  // records an edit itself — callers push to app.edit() explicitly (see
  // recordSkeletonEdit) — since this is also called for non-edits: resyncing
  // the render after a failed drag, and seeding the initial state.
  function adoptSkeleton(skeleton) {
    currentSkeleton = skeleton;
    // logBrinkSkeleton(skeleton);
    view.renderBrinkSkeleton(skeleton);
    const V = skeleton.vertices.length;
    const E = skeleton.edges.length;
    const F = skeleton.faces.length;
    const bipartite = isBipartite(V, skeleton.edges);
    skeletonStatsEl.innerHTML =
      `Skeleton: V ${V}, E ${E}, F ${F}<br>Euler χ: ${V - E + F}<br>` +
      `Orientable: ${bipartite ? 'yes' : 'no'}`;
    view.renderBoundaryCubeFaces(positions);
  }

  // The graph-BREAKING path: the cubes are ground truth, so derive the graph
  // from them and adopt the result, without recording an edit. Used to seed
  // the initial render and to resync after a failure; ordinary voxel
  // add/remove/reset/load record their own edit around this (see below).
  function updateBrinkSkeleton() {
    adoptSkeleton(computeBrinkSkeleton(positions));
  }

  function reset() {
    // Batch: raw removes/add, then one recompute/render. A per-cube
    // removeVoxel loop is O(N²) and rebuilds every InstancedMesh per cube,
    // which locks up on large models (e.g. a 37k-cube loaded skeleton).
    const before = currentSkeleton ?? computeBrinkSkeleton(positions);
    for (const { x, y, z } of [...positions]) removeVoxelRaw(x, y, z);
    addVoxelRaw(0, 0, 0);
    const after = computeBrinkSkeleton(positions);
    recordSkeletonEdit(before, after, 'Reset');
    adoptSkeleton(after);
    updateStatus();
  }

  // Presence toggles that DON'T recompute the skeleton — for batched edits
  // (a cubes-mode drag sweeping many cells, a face-move, a reset/load) where
  // the caller recomputes once at the end via updateBrinkSkeleton() or a
  // single computeBrinkSkeleton() call of its own.
  function addVoxelRaw(x, y, z) {
    if (!inBounds(x, y, z) || hasVoxel(x, y, z)) return false;
    occupied.set(key(x, y, z), positions.length);
    positions.push({ x, y, z });
    return true;
  }

  function removeVoxelRaw(x, y, z) {
    const removeKey = key(x, y, z);
    const removeIdx = occupied.get(removeKey);
    if (removeIdx === undefined) return false;
    const lastIdx = positions.length - 1;
    const lastPos = positions[lastIdx];
    if (removeIdx !== lastIdx) {
      positions[removeIdx] = lastPos;
      occupied.set(key(lastPos.x, lastPos.y, lastPos.z), removeIdx);
    }
    positions.pop();
    occupied.delete(removeKey);
    return true;
  }

  let downX = 0;
  let downY = 0;

  // Restore previously saved state, if any. A `?design=` URL param, when
  // present and valid, overrides the autosaved draft; with neither, fall back
  // to a single cube centered in the build volume.
  //
  // loadFromDesignParam throws on a bad URL or unparseable file rather than
  // reporting it itself (persistence.js owns no DOM), so the user-facing
  // message is raised here and the load falls back to the autosaved draft.
  async function designParamState() {
    try {
      return await loadFromDesignParam();
    } catch (error) {
      console.error('Load from ?design= failed:', error);
      errorEl.style.display = 'grid';
      errorEl.textContent = `Load from design URL failed: ${error?.message || error}`;
      return null;
    }
  }
  // A `?design=` URL, when present and valid, overrides any autosaved draft.
  // The two can't both be checked synchronously: <design-app>'s app-restore
  // only fires (asynchronously, on a microtask) once something is listening
  // for it, so a ?design= state is applied directly here, and the restore
  // listener is wired up ONLY when there was none — attaching it unconditionally
  // would race the ?design= state applied above and let whichever settles last
  // silently win.
  const saved = await designParamState();

  applyInitialState(saved);
  if (!saved) {
    app.addEventListener('app-restore', (event) => {
      applyInitialState(parseSavedState(event.detail.text));
    });
  }

  // Seed the voxel set (and render) from an already-resolved state, or fall
  // back to a single cube. Used only at startup — an autosaved draft is not a
  // user edit, so it deliberately does NOT go through recordSkeletonEdit:
  // <design-app>'s undo stack simply starts empty (Undo disabled) until the
  // user makes a first real change, which is the correct "nothing to undo yet"
  // state.
  //
  // Mode on entry: an actual restored state (autosave or ?design=) opens in
  // Graph mode, matching a deliberate load/open; the fallback single cube
  // (nothing to restore) opens in Cubes mode, matching a fresh "New".
  function applyInitialState(state) {
    if (state?.camera) view.setCameraState(state.camera);
    if (state?.faceVisibility) faceVisibility.splice(0, 3, ...state.faceVisibility);
    view.applyFaceVisibility();

    // Restore the voxel set in ONE batch (raw adds, then a single
    // recompute/render) — a per-cube addVoxel loop here is O(N²) and rebuilds
    // every InstancedMesh per cube, hanging startup on large saved models.
    // Prefer the drawing over stored cubes when both are present.
    const restored = state
      ? hasDrawing(state)
        ? dropOutOfBounds(fillCubesFromSkeleton(state.skeleton))
        : state.positions
      : null;

    for (const { x, y, z } of [...positions]) removeVoxelRaw(x, y, z);
    if (restored?.length) {
      for (const { x, y, z } of restored) addVoxelRaw(x, y, z);
    } else {
      addVoxelRaw(0, 0, 0);
    }
    updateBrinkSkeleton();
    setMode(restored?.length ? 'graph' : 'cubes');
  }

  function setMode(nextMode) {
    if (mode === nextMode) return;
    cancelGraphDrag(); // abandon any in-flight graph-mode drag
    cancelCubesDrag(); // abandon any in-flight cubes-mode drag
    mode = nextMode;
    cubesBtn.classList.toggle('active', mode === 'cubes');
    graphBtn.classList.toggle('active', mode === 'graph');
    // Skeleton edges/vertices are graph-mode-only; cubes mode shows only cube
    // faces, outlined in black instead (see CLAUDE.md's Two modes note —
    // Gp/Gb are visually distinct).
    view.setSkeletonVisible(mode === 'graph');
    view.setCubeEdgesVisible(mode === 'cubes');
    view.hideHoverOutline();
    updateStatus();
  }

  // A plain click/tap (not a drag) that misses every small boundary-cube face:
  // it falls through to the giant boundary cube, and hitting one of ITS faces
  // cycles that axis's face visibility (solid -> translucent -> hidden). This
  // is the only thing a plain click still does — both modes edit exclusively
  // by dragging (see startCubesDrag / startGraphDrag) — so a click that also
  // misses the giant box does nothing. The ray crosses two walls (the box
  // faces are DoubleSide), returned sorted near->far; take the LAST so we
  // cycle the FAR face the user actually sees, not the near wall in front of
  // the camera.
  function handleClick(clientX, clientY) {
    if (realizer.isBusy()) return; // edits are suspended while a realization runs
    if (view.getIntersection(clientX, clientY).length) return; // hit a cube face: not a background click
    const boxHits = view.getIntersection(clientX, clientY, [view.boundsBox]);
    const farHit = boxHits[boxHits.length - 1];
    if (farHit && farHit.face) {
      view.cycleFaceVisibility(farHit.face.materialIndex >> 1);
    }
  }

  // Closest edit-axis value on the line through `linePoint` (parallel to
  // `axis`) to the pointer ray — the drag value. Derived by minimizing the
  // distance between the ray and that axis-parallel line.
  function dragValueFromRay(clientX, clientY, axis, linePoint) {
    const ray = view.rayFrom(clientX, clientY);

    // Line L: linePoint + t*e_axis. Ray R: o + s*d. Solve for t minimizing
    // |R - L|^2. With e a unit basis vector, using the standard closest-points
    // -of-two-lines formula.
    const e = [0, 0, 0];
    e[axis] = 1;
    const d = [ray.direction.x, ray.direction.y, ray.direction.z];
    const o = [ray.origin.x, ray.origin.y, ray.origin.z];
    // w0 points from the ray's origin to the axis line's point; the standard
    // two-line closest-approach formula below is written for this direction
    // (the reverse, o - linePoint, negates t and drags the face backward).
    const w0 = [linePoint[0] - o[0], linePoint[1] - o[1], linePoint[2] - o[2]];
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const a = 1; // dot(e,e)
    const b = dot(e, d);
    const c = dot(d, d);
    const dd = dot(e, w0);
    const ee = dot(d, w0);
    const denom = a * c - b * b;
    // t is the parameter along the axis line (the value offset from linePoint).
    const t = Math.abs(denom) < 1e-8 ? 0 : (b * ee - c * dd) / denom;
    return linePoint[axis] + t;
  }

  // --- The swapping drag ---------------------------------------------------
  // A drag is a SEQUENCE OF DISCRETE STEPS applied to live state, not a
  // continuous slide with snap zones. The pointer moves continuously, but the
  // dragged face's plane is always an INTEGER: crossing a threshold fires a
  // step, which moves the face to the next plane it can legally occupy and
  // swaps whatever was in the way back into the plane it left. The drawing is
  // therefore a legal configuration at every instant of the gesture, which is
  // what lets the skeleton itself follow the drag — there is no half-way state
  // to render.
  //
  // A plane the scan SKIPS (see planSwapStep) is a plane the face never
  // occupies for any pointer position, so it "snaps past": the two-plane jump
  // is the feedback, needing no special rendering.

  // Fire a step when the pointer passes this fraction of the way to the
  // candidate plane. Below 0.5 stepping forward and stepping back have
  // different thresholds, which is the HYSTERESIS that stops the face
  // chattering when the pointer sits near a boundary.
  const STEP_THRESHOLD = 0.6;

  // Advance the drag by one step in `dir`, if the pointer has moved far enough
  // and a legal destination exists. Returns true if a step was applied.
  function trySwapStep(dir) {
    const { axis, face, dragValue, index, limits, dragged } = drag;
    const from = planeOfFace(drag.skeleton, axis, face.key);
    if (from === null) return false;
    // Has the pointer actually reached toward the next plane?
    if (dir > 0 ? dragValue < from + STEP_THRESHOLD : dragValue > from - STEP_THRESHOLD) return false;

    const step = planSwapStep(drag.skeleton, axis, face.key, dragged, index, dir, limits);
    if (!step) return false;
    // Don't step past where the pointer actually is: a skip can jump several
    // planes, and overshooting the pointer would run away from the gesture.
    if (dir > 0 ? step.plane > dragValue + 1 : step.plane < dragValue - 1) return false;

    const next = applySwapStep(drag.skeleton, axis, face.key, step);
    if (!next) return false; // would fuse vertices: treat as a wall

    updateSwapIndex(index, step, face.key);
    drag.skeleton = next;
    drag.steps.push(step);
    return true;
  }

  // Undo the most recent step. Reverse POPS the stack rather than re-scanning:
  // a backward scan is not guaranteed to reproduce the forward step's partner,
  // because the scan is direction-relative and the swappers have changed planes
  // (forward may skip a plane that backward would accept, stranding them). See
  // dev-docs/face-swap-drag.md.
  function undoSwapStep() {
    const { axis, face, dragValue, index } = drag;
    const step = drag.steps[drag.steps.length - 1];
    if (!step) return false;
    // Only retreat once the pointer has come back past the plane we left.
    const back = step.plane > step.from;
    if (back ? dragValue > step.plane - STEP_THRESHOLD : dragValue < step.plane + STEP_THRESHOLD) return false;

    // The inverse step: the face returns to `from`, its swappers to `plane`.
    const inverse = { plane: step.from, from: step.plane, swapKeys: step.swapKeys };
    const prev = applySwapStep(drag.skeleton, axis, face.key, inverse);
    if (!prev) return false;

    updateSwapIndex(index, inverse, face.key);
    drag.skeleton = prev;
    drag.steps.pop();
    return true;
  }

  function startGraphDrag(axis, hitId, hitPoint) {
    const face = connectedFace(axis, hitId, hitPoint);
    if (!face) return false; // not a grabbable face: let the gesture rotate the camera

    // The drag's live model of which face sits in which plane. It is MUTATED
    // as steps are applied, so each step sees the arrangement the previous
    // steps produced — the relabelling that makes a drag a repeated
    // application of one local rule.
    const { index, lo, hi } = buildSwapPlaneIndex(currentSkeleton, axis);
    const dragged = prepareFace(face.segments);
    const limits = { lo, hi };

    // Can the face move at all, in either direction? Under swapping, a plane
    // holding faces is no longer a barrier — only vertex impedance is — so
    // "trapped" now means genuinely boxed in by collinear neighbors.
    const forward = planSwapStep(currentSkeleton, axis, face.key, dragged, index, 1, limits);
    const backward = planSwapStep(currentSkeleton, axis, face.key, dragged, index, -1, limits);
    if (!forward && !backward) {
      // Grabbable but boxed in. Still CONSUME the gesture (suspend the
      // trackball) and show the impeders, so it reads as "trapped, here's why"
      // instead of an unexpected camera rotation.
      const { impeders } = dragBounds(axis, face.vertexIndices, currentSkeleton);
      trapped = true;
      view.setControlsEnabled(false);
      view.showImpeders(impeders);
      return true;
    }

    // A point on the face (a segment endpoint lifted into the current plane)
    // gives the axis-parallel line the pointer ray is projected onto.
    const [ua, ub] = inPlaneAxes(axis);
    const linePoint = [0, 0, 0];
    linePoint[axis] = face.coord;
    linePoint[ua] = face.segments[0][0];
    linePoint[ub] = face.segments[0][1];

    drag = {
      axis,
      face,
      dragged,
      index,
      limits,
      baseSkeleton: currentSkeleton, // the graph as it stood before the gesture
      skeleton: currentSkeleton, // rewritten in place as steps are applied
      steps: [], // the applied steps, popped on reverse and committed on release
      linePoint,
      dragValue: face.coord,
    };
    view.setControlsEnabled(false);
    view.showImpeders((forward ?? backward).impeders);
    view.renderBrinkSkeleton(drag.skeleton);
    view.showGrabbedFace(axis, face.segments, face.coord);
    return true;
  }

  // Redraw the model mid-drag, after a step has rewritten the drawing. The
  // cubes are refilled along with the skeleton: without them the drag is too
  // confusing to read, since the shell is the shape you are actually editing.
  //
  // This is the per-STEP cost, not the per-pointermove cost — steps fire only
  // on plane crossings. It deliberately does NOT go through adoptSkeleton: the
  // undo edit belongs to the commit, not to each intermediate state of a
  // gesture in flight. `currentSkeleton` is left alone too; the drag owns its
  // own drawing until it commits.
  //
  // Bulk voxel rules from CLAUDE.md apply: raw primitives only, and exactly one
  // render at the end.
  function redrawDragStep() {
    let cubes;
    try {
      cubes = dropOutOfBounds(fillCubesFromSkeleton(drag.skeleton));
    } catch (error) {
      // A step that cannot be filled still has a valid skeleton, so show that
      // much rather than dropping the frame entirely.
      console.error('Face drag: could not refill cubes for this step:', error);
      view.renderBrinkSkeleton(drag.skeleton);
      return;
    }
    for (const { x, y, z } of [...positions]) removeVoxelRaw(x, y, z);
    for (const { x, y, z } of cubes) addVoxelRaw(x, y, z);
    view.renderBrinkSkeleton(drag.skeleton);
    view.renderBoundaryCubeFaces(positions);
  }

  function updateGraphDrag(clientX, clientY) {
    drag.dragValue = dragValueFromRay(clientX, clientY, drag.axis, drag.linePoint);

    // Apply as many steps as the pointer has earned. The loop matters: a fast
    // pointer move can cross several planes between two pointermove events.
    // Retreat is tried first, and only one direction can make progress at a
    // time, so the two loops cannot fight.
    let changed = false;
    while (undoSwapStep()) changed = true;
    if (!changed) {
      const dir = drag.dragValue > planeOfFace(drag.skeleton, drag.axis, drag.face.key) ? 1 : -1;
      while (trySwapStep(dir)) changed = true;
    }
    // The skeleton and the cubes only change when a step fires, so rebuild
    // them only then — NOT per pointermove.
    if (changed) redrawDragStep();

    // The OUTLINE, by contrast, follows the pointer continuously — it is drawn
    // at the raw drag value, not at the face's integer plane. That continuous
    // motion is the drag's feedback: the outline leads, and the skeleton snaps
    // to it a step at a time. Without it the gesture has nothing tracking the
    // pointer between steps and reads as unresponsive.
    view.moveGrabbedFace(drag.axis, drag.face.segments, drag.dragValue);
  }

  function commitGraphDrag() {
    const { skeleton, steps, baseSkeleton } = drag;
    const moved = steps.length > 0;
    endDrag();
    if (!moved) {
      // No step ever fired, so nothing moved and `skeleton` is still
      // `baseSkeleton`. The skeleton meshes were never rewritten either (only
      // an applied step redraws them), so there is nothing to resync — a plain
      // click in move mode must not cost a boundary-face rebuild or an
      // autosave.
      return;
    }

    // `positions` is ALREADY correct: redrawDragStep refilled it after the last
    // applied step, and no step is left unrendered. So the commit does not
    // refill — it only does the things a gesture in flight deliberately skips:
    // adopt the drawing as current and record one edit for the whole gesture
    // (the redo/undo thunks refill on demand via restoreSkeleton, same as
    // every other edit).
    //
    // Cubes are derived purely to render, pick, and export — they are not
    // consulted to rebuild the graph, so `adoptSkeleton` (not
    // `updateBrinkSkeleton`) takes the graph we already hold.
    recordSkeletonEdit(baseSkeleton, skeleton, 'Move face');
    adoptSkeleton(skeleton);
    updateStatus();
  }

  function endDrag() {
    drag = null;
    trapped = false;
    view.setControlsEnabled(true);
    view.hideGrabbedFace();
    view.hideImpeders();
  }

  function cancelGraphDrag() {
    // A live drag has already rewritten BOTH the rendered skeleton and the
    // voxel set in place, so abandoning it must put the pre-gesture drawing
    // back and refill the cubes from it — the steps are discarded wholesale
    // rather than popped one at a time.
    const restore = drag && drag.steps.length ? drag.baseSkeleton : null;
    if (drag || trapped) endDrag();
    if (!restore) return;
    try {
      const cubes = dropOutOfBounds(fillCubesFromSkeleton(restore));
      for (const { x, y, z } of [...positions]) removeVoxelRaw(x, y, z);
      for (const { x, y, z } of cubes) addVoxelRaw(x, y, z);
      adoptSkeleton(restore);
    } catch (error) {
      console.error('Face drag: could not restore cubes after cancel:', error);
      updateBrinkSkeleton(); // cubes may be half-swapped: re-derive from them
    }
  }

  // --- Cubes-mode drag ------------------------------------------------------
  // Adapted from the design-app sample (sample/cubes.js + scene.js): grab any
  // boundary face and drag along its normal. Dragging OUTWARD from the face
  // ("pull") sweeps empty cells into cubes; dragging INWARD ("push") carves
  // them away. Crossing another face flips the rule, so a drag that runs into
  // existing cubes starts carving through them, and one that breaks out the
  // far side starts laying cubes down again.
  //
  // Unlike the graph-mode drag, this recomputes the skeleton and records ONE
  // undo edit only at release (see commitCubesDrag) — mid-drag, only the cube
  // faces are re-rendered (view.renderBoundaryCubeFaces), never the skeleton,
  // per CLAUDE.md's bulk-edit rule and this mode's "no graph shown" rendering.

  // Refuse to empty the model completely; there must always be something left
  // to grab hold of. Mirrors CubeModel#planStep in the sample.
  function canRemoveLastCube() {
    return positions.length > 1;
  }

  // Toggle exactly one cell per the parity rule: occupied -> remove, empty ->
  // add. Updates the voxel set AND the rendered boundary faces incrementally
  // (view.toggleCubeFaces touches only the ~6 faces this one cube's toggle
  // can affect, not the whole model — see sceneRenderer.js). Returns true if
  // a change was made.
  function toggleCubesDragCell(cell) {
    const [x, y, z] = cell;
    if (hasVoxel(x, y, z)) {
      if (!canRemoveLastCube()) return false;
      if (!removeVoxelRaw(x, y, z)) return false;
      view.toggleCubeFaces(x, y, z, false, hasVoxel);
      return true;
    }
    if (!addVoxelRaw(x, y, z)) return false;
    view.toggleCubeFaces(x, y, z, true, hasVoxel);
    return true;
  }

  function startCubesDrag(clientX, clientY) {
    const hit = view.getIntersection(clientX, clientY)[0];
    if (!hit || hit.instanceId === undefined || hit.instanceId === null) return false;
    const axis = view.faceMeshAxis(hit.object);
    const info = view.boundaryFaceInfo(axis)?.[hit.instanceId];
    if (!info) return false;
    const dir = [0, 0, 0];
    dir[info.axis] = info.sign;

    cubesDrag = {
      cell: [info.x, info.y, info.z],
      dir,
      facePoint: info.center, // for screen-space projection, NOT the parity toggle
      baseSkeleton: currentSkeleton ?? computeBrinkSkeleton(positions),
      startX: clientX,
      startY: clientY,
      moved: false,
    };
    view.setControlsEnabled(false);
    return true;
  }

  function updateCubesDrag(clientX, clientY) {
    const dx = clientX - cubesDrag.startX;
    const dy = clientY - cubesDrag.startY;
    const stepPixels = view.dragStepPixels();
    if (Math.hypot(dx, dy) < stepPixels) return;

    // Project the drag onto the face normal in screen space: dragging along
    // the outward normal pulls (adds), against it pushes (removes). Anchored
    // at the working face's actual world position (facePoint), not the
    // lattice cell — they differ by up to half a cube, which perspective
    // projection can turn into a meaningfully wrong screen direction.
    const outward = view.screenDirection(cubesDrag.facePoint, cubesDrag.dir);
    const along = dx * outward.x + dy * outward.y;
    const kind = along >= 0 ? 'pull' : 'push';
    // Pulling acts on the cell just beyond the grabbed face; pushing acts on
    // the grabbed cell itself.
    const [cx, cy, cz] = cubesDrag.cell;
    const [dxAxis, dyAxis, dzAxis] = cubesDrag.dir;
    const target = kind === 'pull' ? [cx + dxAxis, cy + dyAxis, cz + dzAxis] : [cx, cy, cz];

    // Re-anchor at the current pointer position either way, so the next step
    // is measured from here.
    cubesDrag.startX = clientX;
    cubesDrag.startY = clientY;

    if (!toggleCubesDragCell(target)) return; // refused (e.g. last cube): face stays put
    cubesDrag.moved = true;

    // Advance the working face (and its projection point) one cell along the
    // sweep direction, regardless of whether this step added or removed — the
    // sweep keeps going the way the user is dragging.
    const step = kind === 'pull' ? 1 : -1;
    cubesDrag.cell = [cx + dxAxis * step, cy + dyAxis * step, cz + dzAxis * step];
    const [fx, fy, fz] = cubesDrag.facePoint;
    cubesDrag.facePoint = [fx + dxAxis * step, fy + dyAxis * step, fz + dzAxis * step];

    // No skeleton recompute mid-drag (it stays hidden throughout — Cubes mode
    // never shows it), and toggleCubesDragCell above already updated the
    // rendered faces incrementally — no full-model re-render per step.
  }

  function commitCubesDrag() {
    const { baseSkeleton, moved } = cubesDrag;
    cubesDrag = null;
    view.setControlsEnabled(true);
    view.finalizeBoundaryFaces(); // bring picking's bounding spheres back in sync
    if (!moved) return; // nothing changed: no recompute, no history entry

    const after = computeBrinkSkeleton(positions);
    recordSkeletonEdit(baseSkeleton, after, 'Edit cubes');
    // adoptSkeleton would also render the (hidden) skeleton meshes and the
    // stats readout; both are still worth keeping in sync for when the user
    // switches to Graph mode, so use it rather than a lighter render.
    adoptSkeleton(after);
    updateStatus();
  }

  // Abandon an in-flight cubes-mode drag (e.g. on a mode switch), restoring
  // the pre-gesture cubes without recomputing or recording anything.
  function cancelCubesDrag() {
    if (!cubesDrag) return;
    const { baseSkeleton, moved } = cubesDrag;
    cubesDrag = null;
    view.setControlsEnabled(true);
    if (!moved) return;
    try {
      const cubes = dropOutOfBounds(fillCubesFromSkeleton(baseSkeleton));
      for (const { x, y, z } of [...positions]) removeVoxelRaw(x, y, z);
      for (const { x, y, z } of cubes) addVoxelRaw(x, y, z);
      view.renderBoundaryCubeFaces(positions);
    } catch (error) {
      console.error('Cubes drag: could not restore cubes after cancel:', error);
      updateBrinkSkeleton(); // cubes may be half-swapped: re-derive from them
    }
  }

  cubesBtn.addEventListener('click', () => setMode('cubes'));
  graphBtn.addEventListener('click', () => setMode('graph'));
  cancelBusyBtn.addEventListener('click', () => cancelRealization());

  // <design-app> drives undo/redo (button + keyboard), Save/Save As, and the
  // File menu's Open/New; the app only has to serialize and deserialize its
  // own document and apply the result.
  app.addEventListener('app-save', (event) => {
    event.detail.setText(serialize(snapshot()));
  });

  app.addEventListener('app-open', (event) => {
    const state = parseSavedState(event.detail.text);
    if (!state) {
      alert(`Could not open ${event.detail.name}: not a valid Orthohedra save.`);
      return;
    }
    applyLoadedFile(state, 'cubes');
  });

  app.addEventListener('app-new', () => {
    reset();
    setMode('cubes'); // a fresh "New" always opens in Cubes mode
    view.centerView(positions);
  });

  // Custom menu items: things the component's own File/Edit menus don't
  // cover. "Load Abstract…" is a distinct interpretation of an opened file
  // (re-realize coordinates from a coordinate-free graph), not a plain open.
  // "Center View" only pans/zooms the camera onto the model — the model
  // itself is untouched, so it is not an undoable edit.
  app.setMenu([
    { id: 'load-abstract', label: 'Load Abstract…' },
    { id: 'center-view', label: 'Center View' },
  ]);
  app.addEventListener('menu-select', async (event) => {
    if (event.detail.id === 'load-abstract') {
      const state = await pickAndParseFile();
      if (state) applyLoadedFile(state, 'abstract');
    } else if (event.detail.id === 'center-view') {
      view.centerView(positions);
    }
  });

  view.domElement.addEventListener('pointerdown', (event) => {
    downX = event.clientX;
    downY = event.clientY;
    if (realizer.isBusy()) return;

    if (mode === 'graph') {
      // Grabbing ANY visible boundary face starts a drag along that face's
      // normal axis, and suspends the trackball so the camera doesn't rotate
      // mid-drag. The axis is whichever face mesh was hit.
      const hit = view.getIntersection(event.clientX, event.clientY)[0];
      if (hit && hit.instanceId !== undefined && hit.instanceId !== null) {
        const axis = view.faceMeshAxis(hit.object);
        if (axis !== -1 && startGraphDrag(axis, hit.instanceId, hit.point)) {
          view.hideHoverOutline();
          event.preventDefault();
        }
      }
    } else if (startCubesDrag(event.clientX, event.clientY)) {
      view.hideHoverOutline();
      event.preventDefault();
    }
  });

  view.domElement.addEventListener('pointermove', (event) => {
    if (drag) {
      updateGraphDrag(event.clientX, event.clientY);
      return;
    }
    if (cubesDrag) {
      updateCubesDrag(event.clientX, event.clientY);
      return;
    }

    // Hover highlight over any grabbable (visible) boundary face — the same
    // set in both modes, since either drag can grab any visible face.
    const hits = view.getIntersection(event.clientX, event.clientY);
    if (!hits.length || hits[0].instanceId === undefined || hits[0].instanceId === null) {
      view.hideHoverOutline();
      return;
    }

    view.showHoverOutline(hits[0].object, hits[0].instanceId);
  });

  view.domElement.addEventListener('pointerup', (event) => {
    if (drag) {
      commitGraphDrag();
      return;
    }
    if (trapped) {
      endDrag(); // clear the trapped-face preview; nothing to commit
      return;
    }
    if (cubesDrag) {
      commitCubesDrag();
      return;
    }
    const dist = Math.hypot(event.clientX - downX, event.clientY - downY);
    if (dist > 3) return;
    handleClick(event.clientX, event.clientY);
  });

  window.addEventListener('resize', () => view.handleResize());

  view.start();
}

main().catch((error) => {
  console.error(error);
  errorEl.style.display = 'grid';
  errorEl.textContent = `Startup failed: ${error?.message || error}`;
});
