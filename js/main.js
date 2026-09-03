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
import {
  saveToLocalStorage as writeLocalStorage,
  loadFromLocalStorage,
  createFileStore,
  loadFromDesignParam,
} from "./persistence.js";
import { createSceneRenderer } from "./sceneRenderer.js";

const app = document.getElementById('app');
const errorEl = document.getElementById('error');
const statusEl = document.getElementById('status');
const skeletonStatsEl = document.getElementById('skeletonStats');
const buildBtn = document.getElementById('buildBtn');
const destroyBtn = document.getElementById('destroyBtn');
const resetBtn = document.getElementById('resetBtn');
const moveBtn = document.getElementById('moveBtn');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const saveBtn = document.getElementById('saveBtn');
const saveAsBtn = document.getElementById('saveAsBtn');
const loadBtn = document.getElementById('loadBtn');
const loadAbstractBtn = document.getElementById('loadAbstractBtn');
const busyOverlay = document.getElementById('busyOverlay');
const cancelBusyBtn = document.getElementById('cancelBusyBtn');

async function main() {
  // All drawing lives in sceneRenderer.js; this is the only handle to it.
  // The visibility-cycle callback is wired after saveToLocalStorage exists.
  const view = createSceneRenderer(app, {
    onFaceVisibilityChange: () => saveToLocalStorage(),
  });
  const faceVisibility = view.faceVisibility;

  // --- Move mode: drag a connected boundary face along its orthogonal axis --
  // `moveMode` is a single toggle. While active, ANY visible boundary face can
  // be grabbed; the axis of the face hit (its normal) becomes the drag axis, so
  // the face slides freely along that axis. Invisible (hidden) faces aren't
  // grabbable. Rendering is independent and driven entirely by per-axis face
  // visibility (see applyFaceVisibility).
  let moveMode = false;
  let currentSkeleton = null; // cached { vertices, edges, faces } from updateBrinkSkeleton

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
  // Each entry snapshots the Graph Drawing, which IS the model state. Cubes are
  // left out because they are derived — a restore refills them from the drawing
  // (~49ms even for the 37k-cube Klein quartic, imperceptible for an undo).
  // Face visibility and camera are left out because they are rendering choices,
  // not model state: an undo should revert your edit without disturbing how you
  // are looking at it.
  //
  // Snapshots rather than per-operation inverses: the drawing is small (3.9 KB
  // for the largest design in designs/, so even hundreds of entries cost a
  // couple of MB), and an inverse that is subtly wrong corrupts state silently,
  // which a snapshot cannot do. History is unbounded, and one stack carries
  // both graph-preserving and graph-breaking edits.
  //
  // No deep copy is needed: every producer of a skeleton (computeBrinkSkeleton,
  // applySwapStep) returns a fresh object with a fresh vertices array,
  // and nothing mutates a skeleton in place.
  const history = { entries: [], index: -1 }; // entries[index] is the current state

  // --- Persistence glue ----------------------------------------------------
  // persistence.js owns the save FORMAT but knows nothing about this app's
  // state, so everything it writes comes through here. `snapshot()` gathers the
  // three things a save records; the skeleton is rebuilt from `positions`
  // rather than read from `currentSkeleton` so an autosave always reflects the
  // cubes, exactly as before the split.
  function snapshot() {
    return {
      skeleton: computeBrinkSkeleton(positions),
      faceVisibility,
      camera: view.getCameraState(),
    };
  }

  function saveToLocalStorage() {
    writeLocalStorage(snapshot());
  }

  const fileStore = createFileStore(snapshot);
  const { save, saveAs } = fileStore;
  // The file store parses; applyLoadedFile decides what the parsed state MEANS.
  const load = (interpretation = 'cubes') => fileStore.load(interpretation, applyLoadedFile);

  function applyLoadedState(state) {
    if (!state) return;

    // Swap the whole voxel set in ONE batch using the raw (non-recomputing)
    // primitives, then recompute/render the skeleton exactly once at the end.
    // Using addVoxel/removeVoxel here would recompute the brink skeleton and
    // rebuild every instanced mesh on EACH cube — O(N²) work plus N redundant
    // renders — which hangs and crashes the page on large models (e.g. a
    // 37k-cube realized skeleton).
    for (const { x, y, z } of [...positions]) removeVoxelRaw(x, y, z);
    for (const { x, y, z } of state.positions) addVoxelRaw(x, y, z);
    updateBrinkSkeleton({ record: true, label: 'Load' });

    faceVisibility.splice(0, 3, ...state.faceVisibility);
    view.applyFaceVisibility();

    if (state.camera) {
      view.setCameraState(state.camera);
    }

    updateStatus(mode);
    saveToLocalStorage();
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

  function updateStatus(mode) {
    const label = moveMode ? 'Move' : mode === 'build' ? 'Build' : 'Destroy';
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

  // Push a new state, discarding any redo tail: editing after an undo forks
  // history, and the abandoned branch is gone.
  function recordHistory(skeleton, label) {
    history.entries.length = history.index + 1;
    history.entries.push({ label, skeleton });
    history.index = history.entries.length - 1;
    updateHistoryButtons();
  }

  const canUndo = () => history.index > 0;
  const canRedo = () => history.index < history.entries.length - 1;

  function updateHistoryButtons() {
    undoBtn.disabled = !canUndo();
    redoBtn.disabled = !canRedo();
    undoBtn.title = canUndo() ? `Undo ${history.entries[history.index].label}` : 'Nothing to undo';
    redoBtn.title = canRedo() ? `Redo ${history.entries[history.index + 1].label}` : 'Nothing to redo';
  }

  // Restore a recorded state. Cubes are refilled from the drawing rather than
  // stored, using the raw primitives plus a single adoptSkeleton — a per-cube
  // addVoxel loop here would be O(N²) and rebuild every InstancedMesh per cube.
  function restoreHistory(i) {
    const { skeleton } = history.entries[i];
    history.index = i;
    try {
      const cubes = dropOutOfBounds(fillCubesFromSkeleton(skeleton));
      for (const { x, y, z } of [...positions]) removeVoxelRaw(x, y, z);
      for (const { x, y, z } of cubes) addVoxelRaw(x, y, z);
    } catch (error) {
      console.error('Undo/redo failed while refilling cubes from the drawing:', error);
      updateBrinkSkeleton(); // cubes may be half-swapped: re-derive from them
      return;
    }
    // adoptSkeleton renders the cube geometry from `positions`, so the refill
    // above must already have happened. Not recorded: restoring is not an edit.
    adoptSkeleton(skeleton);
    updateHistoryButtons();
    updateStatus(mode);
  }

  function undo() {
    if (canUndo()) restoreHistory(history.index - 1);
  }

  function redo() {
    if (canRedo()) restoreHistory(history.index + 1);
  }

  // Adopt an ALREADY-KNOWN skeleton as the current one: render it, restate the
  // topology readout, rebuild the cube-face geometry, and persist. Deliberately
  // does NOT derive the graph — a graph-preserving edit already holds the
  // graph, and re-deriving it would be both wasteful and lossy (see
  // applySwapStep).
  //
  // `record` is explicit rather than inferred: this function is also called for
  // non-edits — resyncing the render after a failed drag, and seeding the
  // initial state — which must not become undoable steps.
  function adoptSkeleton(skeleton, { record = false, label = '' } = {}) {
    if (record) recordHistory(skeleton, label);
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
    saveToLocalStorage();
  }

  // The graph-BREAKING path: the cubes are ground truth, so derive the graph
  // from them and adopt the result. Every voxel add/remove, reset, and load
  // goes through here.
  function updateBrinkSkeleton(options) {
    adoptSkeleton(computeBrinkSkeleton(positions), options);
  }

  function reset() {
    // Batch: raw removes/add, then one recompute/render. A per-cube
    // removeVoxel loop is O(N²) and rebuilds every InstancedMesh per cube,
    // which locks up on large models (e.g. a 37k-cube loaded skeleton).
    for (const { x, y, z } of [...positions]) removeVoxelRaw(x, y, z);
    addVoxelRaw(0, 0, 0);
    updateBrinkSkeleton({ record: true, label: 'Reset' });
    updateStatus(mode);
  }

  function addVoxel(x, y, z) {
    if (!inBounds(x, y, z) || hasVoxel(x, y, z)) return false;

    const idx = positions.length;
    const pos = { x, y, z };
    positions.push(pos);
    occupied.set(key(x, y, z), idx);

    updateBrinkSkeleton({ record: true, label: 'Add cube' });
    return true;
  }

  function removeVoxel(x, y, z) {
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
    updateBrinkSkeleton({ record: true, label: 'Remove cube' });
    return true;
  }

  // Presence toggles that DON'T recompute the skeleton — for batched edits
  // (e.g. a face-move sweeping many cells) where the caller recomputes once at
  // the end via updateBrinkSkeleton(). Same swap-pop bookkeeping as
  // add/removeVoxel, just without the per-cell recompute.
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

  // Restore previously saved state, if any: face visibility and camera first
  // (so the position-restoring addVoxel calls below, which each trigger a
  // save, re-persist the already-correct values instead of clobbering
  // them with defaults), then the assembly itself. A `design` URL param, if
  // present and valid, overrides the autosaved localStorage state. With
  // nothing saved, fall back to a single cube centered in the build volume.
  //
  // loadFromDesignParam throws on a bad URL or unparseable file rather than
  // reporting it itself (persistence.js owns no DOM), so the user-facing
  // message is raised here and the load falls back to localStorage.
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
  const saved = (await designParamState()) ?? loadFromLocalStorage();

  if (saved?.camera) {
    view.setCameraState(saved.camera);
  }

  if (saved?.faceVisibility) faceVisibility.splice(0, 3, ...saved.faceVisibility);
  view.applyFaceVisibility();

  // Restore the initial voxel set in ONE batch (raw adds, then a single
  // recompute/render) — a per-cube addVoxel loop here is O(N²) and rebuilds
  // every InstancedMesh per cube, hanging startup on large saved models.
  // Autosaves now carry the drawing rather than the cubes, but an autosave
  // written by an older build (positions only) must still restore — so accept
  // either shape, preferring the drawing.
  const restored = saved
    ? hasDrawing(saved)
      ? dropOutOfBounds(fillCubesFromSkeleton(saved.skeleton))
      : saved.positions
    : null;

  if (restored?.length) {
    for (const { x, y, z } of restored) addVoxelRaw(x, y, z);
  } else {
    addVoxelRaw(0, 0, 0);
  }
  // Seed history with the starting state so the first undo has somewhere to
  // return to. Recorded as the base entry, not as an edit the user made.
  updateBrinkSkeleton({ record: true, label: 'Initial state' });

  let mode = 'build';
  let downX = 0;
  let downY = 0;

  function setMode(nextMode) {
    mode = nextMode;
    setMoveMode(false); // Build/Destroy and Move are mutually exclusive
    buildBtn.classList.toggle('active', mode === 'build');
    destroyBtn.classList.toggle('active', mode === 'destroy');
    updateStatus(mode);
  }

  function setMoveMode(on) {
    if (moveMode === on) return;
    cancelDrag();
    moveMode = on;
    moveBtn.classList.toggle('active', on);
    // Rendering is decoupled from the move gesture: face visibility stays in
    // effect whether or not move mode is active.
    if (!on) {
      // nothing to tear down: the drag's visuals are cleared by cancelDrag
    } else {
      // Leaving Build/Destroy: drop their active styling and status.
      buildBtn.classList.remove('active');
      destroyBtn.classList.remove('active');
      view.hideHoverOutline();
      updateStatus(mode);
    }
  }

  function toggleMoveMode() {
    setMoveMode(!moveMode);
  }

  function handleEdit(clientX, clientY) {
    if (realizer.isBusy()) return; // edits are suspended while a realization runs
    const hits = view.getIntersection(clientX, clientY);

    // A click that misses every small boundary-cube face falls through to the
    // giant boundary cube: hitting one of its faces cycles that axis's face
    // visibility (solid -> translucent -> hidden). Checked before the move-mode
    // early return so this rendering control works in any editing mode. The
    // ray crosses two walls (the box faces are DoubleSide), returned sorted
    // near->far; take the LAST so we cycle the FAR face the user actually sees,
    // not the near wall in front of the camera.
    if (!hits.length) {
      const boxHits = view.getIntersection(clientX, clientY, [view.boundsBox]);
      const farHit = boxHits[boxHits.length - 1];
      if (farHit && farHit.face) {
        view.cycleFaceVisibility(farHit.face.materialIndex >> 1);
      }
      return;
    }

    if (moveMode) return; // move mode has its own drag interaction

    const hit = hits[0];
    const id = hit.instanceId;
    if (id === undefined || id === null) return;

    const axis = view.faceMeshAxis(hit.object);
    const info = view.boundaryFaceInfo(axis)?.[id];
    if (!info) return;
    const { x, y, z } = positions[info.cubeIndex];

    if (mode === 'destroy') {
      if (removeVoxel(x, y, z)) updateStatus(mode);
      return;
    }

    const nx = x + (info.axis === 0 ? info.sign : 0);
    const ny = y + (info.axis === 1 ? info.sign : 0);
    const nz = z + (info.axis === 2 ? info.sign : 0);

    if (addVoxel(nx, ny, nz)) updateStatus(mode);
  }

  // --- Move-mode drag state and geometry -----------------------------------
  // { axis, face, dragged, index, limits, baseSkeleton, skeleton, steps,
  //   linePoint, dragValue }
  let drag = null;
  // A grabbed-but-trapped face (grabbable, but with no legal destination): the
  // gesture is consumed and its impeders shown, but there is no live drag.
  let trapped = false;

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

  function startDrag(axis, hitId, hitPoint) {
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
  // on plane crossings. It deliberately does NOT go through adoptSkeleton:
  // history and localStorage belong to the commit, not to each intermediate
  // state of a gesture in flight. `currentSkeleton` is left alone too; the
  // drag owns its own drawing until it commits.
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

  function updateDrag(clientX, clientY) {
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

  function commitDrag() {
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
    // adopt the drawing as current, record one history entry for the whole
    // gesture, and persist.
    //
    // Cubes are derived purely to render, pick, and export — they are not
    // consulted to rebuild the graph, so `adoptSkeleton` (not
    // `updateBrinkSkeleton`) takes the graph we already hold.
    adoptSkeleton(skeleton, { record: true, label: 'Move face' });
    updateStatus(mode);
  }

  function endDrag() {
    drag = null;
    trapped = false;
    view.setControlsEnabled(true);
    view.hideGrabbedFace();
    view.hideImpeders();
  }

  function cancelDrag() {
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

  buildBtn.addEventListener('click', () => setMode('build'));
  destroyBtn.addEventListener('click', () => setMode('destroy'));
  resetBtn.addEventListener('click', () => reset());
  moveBtn.addEventListener('click', () => toggleMoveMode());
  undoBtn.addEventListener('click', () => undo());
  redoBtn.addEventListener('click', () => redo());

  saveBtn.addEventListener('click', () => save());
  saveAsBtn.addEventListener('click', () => saveAs());
  loadBtn.addEventListener('click', () => load('cubes'));
  loadAbstractBtn.addEventListener('click', () => load('abstract'));
  cancelBusyBtn.addEventListener('click', () => cancelRealization());

  // Cmd/Ctrl+Z to undo, Cmd/Ctrl+Shift+Z or Ctrl+Y to redo. Suspended while a
  // realization is running or a drag is in flight, matching the edit guards.
  window.addEventListener('keydown', (event) => {
    if (realizer.isBusy() || drag || trapped) return;
    const accel = event.metaKey || event.ctrlKey;
    if (!accel) return;
    const key = event.key.toLowerCase();
    if (key === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (key === 'y') {
      event.preventDefault();
      redo();
    }
  });

  view.domElement.addEventListener('pointerdown', (event) => {
    downX = event.clientX;
    downY = event.clientY;

    // In move mode, grabbing ANY visible boundary face starts a drag along that
    // face's normal axis, and suspends the trackball so the camera doesn't
    // rotate mid-drag. The axis is whichever face mesh was hit.
    if (moveMode && !realizer.isBusy()) {
      const hit = view.getIntersection(event.clientX, event.clientY)[0];
      if (hit && hit.instanceId !== undefined && hit.instanceId !== null) {
        const axis = view.faceMeshAxis(hit.object);
        if (axis !== -1 && startDrag(axis, hit.instanceId, hit.point)) {
          view.hideHoverOutline();
          event.preventDefault();
        }
      }
    }
  });

  view.domElement.addEventListener('pointermove', (event) => {
    if (drag) {
      updateDrag(event.clientX, event.clientY);
      return;
    }

    // Hover highlight over any grabbable (visible) boundary face — the same set
    // in move mode and in build/destroy, since move now grabs any visible face.
    const hits = view.getIntersection(event.clientX, event.clientY);
    if (!hits.length || hits[0].instanceId === undefined || hits[0].instanceId === null) {
      view.hideHoverOutline();
      return;
    }

    view.showHoverOutline(hits[0].object, hits[0].instanceId);
  });

  view.domElement.addEventListener('pointerup', (event) => {
    if (drag) {
      commitDrag();
      return;
    }
    if (trapped) {
      endDrag(); // clear the trapped-face preview; nothing to commit
      return;
    }
    const dist = Math.hypot(event.clientX - downX, event.clientY - downY);
    if (dist > 3) return;
    handleEdit(event.clientX, event.clientY);
  });

  window.addEventListener('resize', () => view.handleResize());

  updateStatus(mode);

  // OrbitControls fires "change" continuously while dragging or during
  // damped inertial settling — debounce so camera moves don't spam
  // localStorage writes on every frame, only once motion has settled.
  let cameraSaveTimeout = null;
  view.onCameraChange(() => {
    clearTimeout(cameraSaveTimeout);
    cameraSaveTimeout = setTimeout(saveToLocalStorage, 300);
  });

  view.start();
}

main().catch((error) => {
  console.error(error);
  errorEl.style.display = 'grid';
  errorEl.textContent = `Startup failed: ${error?.message || error}`;
});
