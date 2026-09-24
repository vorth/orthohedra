// Reading and writing the saved model — the JSON shape, its validation and
// legacy migrations, plus the one file-load path <design-app> doesn't cover
// ("Load Abstract…", see pickAndParseFile). Ordinary save/open/autosave go
// through <design-app>'s own file and autosave handling in main.js.
//
// The dependency runs ONE WAY: this module turns app state into text and text
// back into a plain state object. It never touches the scene, the voxel set, or
// the camera directly. `serialize` takes an explicit snapshot and `parseSavedState`
// returns a plain object; main.js gathers the one and applies the other. That
// inversion is what lets this file be read (and tested) on its own — it used to
// reach into main()'s closure for `positions`, `camera`, `controls` and
// `faceVisibility`, which made the save format impossible to follow without
// reading the whole app.
//
// What is deliberately NOT here: applying a loaded state to the running app
// (`applyLoadedState`, `derivePositionsSync`, `applyLoadedFile`). Those drive
// voxels, rendering, and history, so they stay in main.js.

import { FACE_SOLID, FACE_TRANSLUCENT, FACE_HIDDEN, inBounds } from "./constants.js";

// Old render-mode strings, migrated to a `faceVisibility` tri-state array on
// load. "normal" -> all solid; each "no-X" made the faces IN A PLANE
// CONTAINING that color translucent (the other two axes), leaving that axis
// solid — reproduced here as [X,Y,Z] translucency.
const LEGACY_RENDER_MODE_VISIBILITY = {
  normal: [FACE_SOLID, FACE_SOLID, FACE_SOLID],
  'no-red': [FACE_SOLID, FACE_TRANSLUCENT, FACE_TRANSLUCENT],
  'no-yellow': [FACE_TRANSLUCENT, FACE_SOLID, FACE_TRANSLUCENT],
  'no-blue': [FACE_TRANSLUCENT, FACE_TRANSLUCENT, FACE_SOLID],
};

const isFaceVisibility = (v) =>
  Array.isArray(v) && v.length === 3 && v.every((s) => s === FACE_SOLID || s === FACE_TRANSLUCENT || s === FACE_HIDDEN);

// faceKey -> hex color string, custom Graph-mode face colors. A plain object
// (not a Map — Maps serialize to "{}"), validated loosely: any object whose
// values are all strings. Malformed entries are dropped individually rather
// than discarding the whole map, since a single corrupted entry shouldn't
// cost the rest of a hand-edited or partially-corrupted file.
const isFaceColors = (v) => v && typeof v === 'object' && !Array.isArray(v);

// What we persist is an abstract GRAPH (edges + faces) together with a
// DRAWING of it (vertex coordinates) — the mathematically meaningful
// content. Cubes are a derivation of the drawing and are NOT saved: for the
// Klein quartic that takes the file from 2106KB to 53KB, and the cubes are
// recovered exactly on load.
//
// This shape is shared by the autosave and the file-save paths. Autosave
// previously wrote `positions` on every edit, which for large models meant
// rewriting hundreds of KB per cube; it now writes the drawing instead.
//
// Takes an explicit snapshot rather than reading app state: `skeleton` is
// whatever computeBrinkSkeleton returned, `faceVisibility` the tri-state array,
// and `camera` the two coordinate triples. Building the skeleton is the
// caller's job, which keeps the save format independent of how it was derived.
export function serialize({ skeleton, faceVisibility, faceColors, camera }) {
  // Persist only the graph and its drawing. The identity fields that
  // computeBrinkSkeleton also returns (ids, keys, lookup Maps) are derived —
  // and Maps would serialize to `{}` — so they stay out of the file.
  // faceColors is keyed by those same faceKeys, which the graph regenerates
  // deterministically from the drawing (see brinkSkeleton.js's "Element
  // identity" comment), so persisting it as a plain faceKey->color object
  // alongside the graph is enough to round-trip: no separate identity data
  // needed.
  const { vertices, edges, faces } = skeleton;
  const state = {
    skeleton: { vertices, edges, faces },
    faceVisibility,
    faceColors,
    camera,
  };
  return JSON.stringify(state, null, 2);
}

export function parseSavedState(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const positions = Array.isArray(parsed.positions)
      ? parsed.positions.filter(
          (p) =>
            p &&
            Number.isInteger(p.x) &&
            Number.isInteger(p.y) &&
            Number.isInteger(p.z) &&
            inBounds(p.x, p.y, p.z)
        )
      : [];

    // Prefer the new tri-state array; fall back to migrating a legacy
    // `renderMode` string; else default to all-solid.
    const faceVis = isFaceVisibility(parsed.faceVisibility)
      ? parsed.faceVisibility
      : LEGACY_RENDER_MODE_VISIBILITY[parsed.renderMode] ?? [FACE_SOLID, FACE_SOLID, FACE_SOLID];

    // Custom face colors: keep only string-valued entries, drop the rest
    // individually rather than discarding the whole map.
    const faceColors = isFaceColors(parsed.faceColors)
      ? Object.fromEntries(Object.entries(parsed.faceColors).filter(([, v]) => typeof v === 'string'))
      : {};

    const isVector3Array = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));
    // `up` is optional: states saved before it was persisted lack it, and
    // setCameraState re-derives a valid one in that case. Drop a malformed
    // `up` rather than the whole camera, so a bad value degrades to the
    // re-derive path instead of losing position/target too.
    const cameraState =
      parsed.camera && isVector3Array(parsed.camera.position) && isVector3Array(parsed.camera.target)
        ? (isVector3Array(parsed.camera.up)
            ? parsed.camera
            : { position: parsed.camera.position, target: parsed.camera.target })
        : null;

    // The skeleton is present only in saved files (not autosave). Validate
    // its shape loosely — it is only consumed by the skeleton/abstract
    // load gestures, which tolerate its absence by falling back gracefully.
    //
    // Two tiers of validity:
    //   - CONCRETE: `vertices` is an array of [x,y,z] points. Usable by every
    //     gesture (the 'skeleton' fill needs real coordinates).
    //   - ABSTRACT-ONLY: valid edges/faces plus a vertex COUNT — from an
    //     integer `numVertices`, or the length of a `vertices` array whose
    //     contents we don't require to be coordinates. Usable only by the
    //     'abstract' gesture, which re-realizes coordinates from the graph.
    // We keep `vertices` (coordinates) when present and valid, else [];
    // `vertexCount` always carries the count so the abstract path works even
    // when coordinates are absent.
    const skel = parsed.skeleton;
    const edgesValid =
      skel &&
      Array.isArray(skel.edges) &&
      skel.edges.every((e) => Array.isArray(e) && e.length === 2 && e.every(Number.isInteger));
    const facesValid =
      skel && Array.isArray(skel.faces) && skel.faces.every((f) => Array.isArray(f) && f.every(Number.isInteger));
    const concreteVertices = skel && Array.isArray(skel.vertices) && skel.vertices.every(isVector3Array);
    const vertexCount = Number.isInteger(skel?.numVertices)
      ? skel.numVertices
      : Array.isArray(skel?.vertices)
        ? skel.vertices.length
        : null;
    let skeleton =
      edgesValid && facesValid && Number.isInteger(vertexCount)
        ? {
            vertices: concreteVertices ? skel.vertices : [],
            vertexCount,
            edges: skel.edges,
            faces: skel.faces,
          }
        : null;

    // Migrate skeletons saved under the OLD convention (cube centers at
    // integers => skeleton vertices at half-integers). Reinterpreting the
    // old integer `positions` in place as least-corners shifts the model
    // +0.5 in world space, so the matching skeleton is the old vertices
    // shifted +0.5, which also makes them the integers the new pipeline
    // expects. Detect the old form by any non-integer vertex coordinate.
    // Only concrete skeletons carry coordinates to migrate.
    if (skeleton && skeleton.vertices.some((v) => v.some((c) => !Number.isInteger(c)))) {
      skeleton = {
        vertices: skeleton.vertices.map((v) => [v[0] + 0.5, v[1] + 0.5, v[2] + 0.5]),
        vertexCount: skeleton.vertexCount,
        edges: skeleton.edges,
        faces: skeleton.faces,
      };
    }

    return { positions, faceVisibility: faceVis, faceColors, camera: cameraState, skeleton };
  } catch {
    return null;
  }
}

// Pick a JSON file and return its parsed state, or null if the user cancelled
// the picker. Uses the File System Access API when available; falls back to a
// hidden file input on browsers that lack it (e.g. Safari, Firefox). Used only
// for "Load Abstract…", the one load path <design-app>'s own File menu doesn't
// cover — a plain "Open" goes through the component's app-open event instead.
export function pickAndParseFile() {
  const hasFileSystemAccess = 'showOpenFilePicker' in window;

  if (hasFileSystemAccess) {
    return (async () => {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'Cubes Editor JSON', accept: { 'application/json': ['.json'] } }],
        });
        const file = await handle.getFile();
        const state = parseSavedState(await file.text());
        if (!state) console.error('Load failed: file is not a valid cubes-editor save.');
        return state;
      } catch (error) {
        if (error?.name !== 'AbortError') console.error('Load failed:', error);
        return null;
      }
    })();
  }

  return new Promise((resolve) => {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      fileInput.remove();
      if (!file) {
        resolve(null);
        return;
      }
      const state = parseSavedState(await file.text());
      if (!state) console.error('Load failed: file is not a valid cubes-editor save.');
      resolve(state);
    });
    fileInput.click();
  });
}

// Fetch a design named by the `design` query parameter — both absolute
// (?design=https://host/path/cubes.json) and relative (?design=designs/cubes.json)
// URLs are supported. Returns a parsed state, or null when the parameter is
// absent; throws on fetch/parse failure so the caller can report it.
export async function loadFromDesignParam() {
  const raw = new URLSearchParams(window.location.search).get('design');
  if (!raw) return null;
  // Resolve against the PAGE url, not this module's — a relative value names a
  // path next to index.html (e.g. designs/foo.json), not next to js/.
  const url = new URL(raw, window.location.href).href;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const state = parseSavedState(await response.text());
  if (!state) {
    throw new Error('not a valid cubes-editor save');
  }
  return state;
}
