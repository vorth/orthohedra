// Pure geometry for the face-drag gesture: where a dragged face may land, and
// what moving it does to the Graph Drawing.
//
// Everything here is a pure function of its arguments — no three.js, no
// rendering, no shared mutable state. That is deliberate: these are the parts
// of the editor with real algorithmic content (the interference rule
// especially), and keeping them free of the scene graph makes them directly
// testable and readable on their own terms.
//
// Two coordinate conventions run throughout:
//   - `axis` is the EDIT axis (0/1/2 = x/y/z), the face's normal and the
//     direction a drag moves it.
//   - in-plane 2D coordinates (u, v) are the other two axes in ascending order,
//     i.e. [0,1,2] minus `axis`. Segments are integer [au, av, bu, bv]
//     quadruples in those coordinates.

import { MIN, MAX } from "./constants.js";

// The two in-plane axes for an edit axis, in ascending order.
export function inPlaneAxes(axis) {
return [0, 1, 2].filter((a) => a !== axis);
}


// Squared distance from point (px,pv) to the segment (ax,av)-(bx,bv), in 2D.
export function pointSegDist2(px, pv, ax, av, bx, bv) {
  const dx = bx - ax;
  const dv = bv - av;
  const len2 = dx * dx + dv * dv;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (pv - av) * dv) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cv = av + t * dv;
  return (px - cx) * (px - cx) + (pv - cv) * (pv - cv);
}

// --- In-plane interference ------------------------------------------------
// Whether two faces sharing a grid plane would touch. This is what decides
// where a dragged face may land: a plane holding other faces is perfectly
// usable as long as the arriving cycle keeps clear of them.
//
// Every skeleton edge is axis-parallel with integer endpoints, so in-plane it
// is fully described by which of the two in-plane directions it runs along,
// its constant coordinate, and its span. That reduces the whole question to
// one-dimensional comparisons — no orientation, winding, or cross products.

// One in-plane [au,av,bu,bv] segment as { dir, fixed, s0, s1 }: `dir` is 0
// when the segment varies in u (so v is constant) and 1 when it varies in v;
// `fixed` is the constant coordinate; s0 <= s1 is the sorted span along `dir`.
// Skeleton edges always join two DISTINCT lattice points, so there are no
// zero-length segments to special-case.
export function normalizeSeg([au, av, bu, bv]) {
  if (av === bv) return { dir: 0, fixed: av, s0: Math.min(au, bu), s1: Math.max(au, bu) };
  return { dir: 1, fixed: au, s0: Math.min(av, bv), s1: Math.max(av, bv) };
}

// A face's in-plane geometry prepared for interference testing: its
// normalized edges plus their bounding box, both in one pass.
export function prepareFace(segments) {
  const segs = [];
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const seg of segments) {
    segs.push(normalizeSeg(seg));
    const [au, av, bu, bv] = seg;
    u0 = Math.min(u0, au, bu);
    u1 = Math.max(u1, au, bu);
    v0 = Math.min(v0, av, bv);
    v1 = Math.max(v1, av, bv);
  }
  return { segs, bbox: { u0, u1, v0, v1 } };
}

// Do two normalized in-plane edges interfere?
//
//   collinear  - same direction AND same fixed coordinate: interfere iff the
//                closed spans overlap AT ALL, a single shared endpoint
//                included. Two collinear brink edges that touch cannot both
//                survive as distinct edges.
//   parallel   - same direction, different fixed coordinate: never.
//   orthogonal - they MEET at (along-A = B.fixed, across-A = A.fixed) iff that
//                point lies on both closed segments. The meeting is harmless
//                only when it is a PROPER CROSSING: strictly interior to BOTH,
//                an X that passes through without either edge terminating on
//                the other. A T-junction (one edge's endpoint landing in the
//                other's interior) or a shared corner puts the point at an
//                endpoint of at least one edge, and interferes.
export function segmentsInterfere(a, b) {
  if (a.dir === b.dir) return a.fixed === b.fixed && a.s0 <= b.s1 && b.s0 <= a.s1;
  const meets = a.s0 <= b.fixed && b.fixed <= a.s1 && b.s0 <= a.fixed && a.fixed <= b.s1;
  if (!meets) return false;
  const interiorA = a.s0 < b.fixed && b.fixed < a.s1;
  const interiorB = b.s0 < a.fixed && a.fixed < b.s1;
  return !(interiorA && interiorB);
}

// Do two prepared faces interfere? NEVER call this with a face against
// itself: a cycle's consecutive edges share corners, so it always interferes
// with itself.
export function facesInterfere(a, b) {
  // Cheap rejection: two faces whose bounding boxes do not even TOUCH can
  // have no interfering edge pair. Note the comparison tests for a genuine
  // GAP — boxes merely sharing a boundary line must still be tested, since a
  // shared boundary is precisely the collinear-overlap and shared-corner case
  // that does interfere.
  if (a.bbox.u1 < b.bbox.u0 || b.bbox.u1 < a.bbox.u0) return false;
  if (a.bbox.v1 < b.bbox.v0 || b.bbox.v1 < a.bbox.v0) return false;
  for (const sa of a.segs) {
    for (const sb of b.segs) {
      if (segmentsInterfere(sa, sb)) return true;
    }
  }
  return false;
}

// Project one skeleton face cycle into in-plane 2D segments, IF it lies in a
// plane normal to `axis`. Returns { coord, vertexIndices, segments } — the
// plane's edit-axis coordinate, the face's skeleton vertex indices, and its
// edges as in-plane [au,av,bu,bv] quadruples on the two other axes — or null
// for a face normal to either of the other two axes.
//
// This is the SINGLE definition of a face's in-plane geometry. The picker
// (which finds the grabbed cycle) and the plane index (which enumerates a
// plane's residents) must agree exactly, or a plane could be offered whose
// occupant the drag never actually tested.
export function projectFace(skeleton, faceIdx, axis) {
  const [ua, ub] = inPlaneAxes(axis);
  const faceEdges = skeleton.faces[faceIdx];
  const vertexIndices = new Set();
  const segments = [];
  let coord = null;
  for (const ei of faceEdges) {
    const [vi, vj] = skeleton.edges[ei];
    const a = skeleton.vertices[vi];
    const b = skeleton.vertices[vj];
    const ca = Math.round(a[axis]);
    const cb = Math.round(b[axis]);
    if (ca !== cb) return null; // an edge along `axis`: this face isn't normal to it
    if (coord === null) coord = ca;
    else if (ca !== coord) return null;
    vertexIndices.add(vi);
    vertexIndices.add(vj);
    segments.push([Math.round(a[ua]), Math.round(a[ub]), Math.round(b[ua]), Math.round(b[ub])]);
  }
  if (coord === null || !segments.length) return null;
  return { coord, vertexIndices: [...vertexIndices], segments };
}

// The faces resident in each plane normal to `axis`, prepared for
// interference testing, plus the skeleton's vertex extent on that axis (which
// bounds the candidate planes worth considering). Built ONCE per drag: the
// skeleton does not change while a drag is in flight, so rescanning per
// candidate plane would repeat this whole pass for every offered value.
//
// `excludeKey` names the dragged face, which must NOT appear in the index —
// it is the thing being moved, not a resident to keep clear of. It is
// excluded by KEY rather than index, matching how commitDrag re-resolves it.
export function buildPlaneFaceIndex(skeleton, axis, excludeKey) {
  const index = new Map(); // plane coord -> [{ segs, bbox }]
  for (let faceIdx = 0; faceIdx < skeleton.faces.length; faceIdx++) {
    if (skeleton.faceKeys[faceIdx] === excludeKey) continue;
    const projected = projectFace(skeleton, faceIdx, axis);
    if (!projected) continue; // normal to one of the other two axes
    if (!index.has(projected.coord)) index.set(projected.coord, []);
    index.get(projected.coord).push(prepareFace(projected.segments));
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (const p of skeleton.vertices) {
    const v = Math.round(p[axis]);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 0;
  }
  return { index, lo, hi };
}

// Edit-axis integer values where the dragged face, placed there, would not
// INTERFERE with any face already in that plane (the drag's valid snap
// destinations). Excludes `excludeCoord` (the face's own current plane) so it
// isn't offered as a destination.
//
// This replaces a far cruder rule — "offer only planes holding no boundary
// face at all" — which was global-per-plane: one unit square anywhere in a
// plane disqualified it for every face in the model, however far apart they
// were. Faces may now SHARE a plane, so long as the arriving cycle keeps
// clear of the residents. They may even cross one in an X, but they may not
// touch: a shared corner, a T-junction, or any collinear overlap would fuse
// or double up brink elements, which a graph-PRESERVING edit may not do. See
// segmentsInterfere for the edge-level rule.
//
// The dragged face's in-plane footprint is PLANE-INDEPENDENT — translating a
// face along its own normal leaves its 2D segments untouched — so `dragged`
// is prepared once by the caller and tested unchanged against every candidate.
//
// The candidate range is the model's extent on this axis (from the plane
// index) plus three planes of headroom each way, enough to pull a face clear
// of the assembly. Occupancy no longer prunes anything, so this only bounds
// the work; dragBounds supplies the real travel limit. A boundary face plane
// can lie anywhere from MIN to MAX+1 (the giant boundary cube spans world
// volume [MIN, MAX+1]); never offer a landing plane outside it.
export function computeAvailablePlanes(axis, excludeCoord, dragged, planeIndex, modelLo, modelHi) {
  const values = [];
  for (let v = Math.max(modelLo - 3, MIN); v <= Math.min(modelHi + 3, MAX + 1); v++) {
    if (v === excludeCoord) continue;
    const residents = planeIndex.get(v);
    if (!residents) {
      values.push(v); // an empty plane is always free
      continue;
    }
    if (residents.every((resident) => !facesInterfere(dragged, resident))) values.push(v);
  }
  return values;
}

// The open interval (lo, hi) of edit-axis values a dragged face may move to
// without any of its vertices overlapping a collinear skeleton edge, plus the
// list of `impeders` — the barrier vertices themselves (world positions), for
// highlighting (at most two per dragged vertex).
//
// Each dragged vertex V sits on some edit-axis-parallel line and is one end
// of an axis-collinear skeleton edge [V, W] (its coordinate shifts on the
// drag). V may pass W (that edge simply reverses), but must not pass any
// OTHER vertex on that line — doing so would make [V, W] overlap the
// neighboring collinear edge. On the sorted line, edges pair consecutive
// vertices, so the barriers bounding V's motion are the vertices immediately
// outside the {V, W} pair: the one just below the pair, and the one just
// above it. V (and W) may sweep freely strictly between those two barriers.
export function dragBounds(axis, vertexIndices, skeleton) {
  const [ua, ub] = inPlaneAxes(axis);
  // Vertices grouped by the axis-parallel line they lie on, sorted along axis.
  const byLine = new Map(); // "u,v" -> [{ coord, point }] sorted by coord
  for (const p of skeleton.vertices) {
    const k = `${p[ua]},${p[ub]}`;
    if (!byLine.has(k)) byLine.set(k, []);
    byLine.get(k).push({ coord: p[axis], point: p });
  }
  for (const arr of byLine.values()) arr.sort((a, b) => a.coord - b.coord);

  // The drag axis is orthogonal to the face, so each dragged vertex has a
  // distinct in-plane (u,v): no axis-parallel drag line carries two of them.
  let lo = -Infinity;
  let hi = Infinity;
  const impeders = [];
  for (const vi of vertexIndices) {
    const p = skeleton.vertices[vi];
    const line = byLine.get(`${p[ua]},${p[ub]}`);
    // Locate the {V, W} pair on the line. Edges pair consecutive vertices
    // (1st-2nd, 3rd-4th, ...), so the pair's start index is even.
    const i = line.findIndex((e) => e.coord === p[axis]);
    const pairStart = i - (i % 2); // even index: lower member of the pair
    const below = pairStart - 1 >= 0 ? line[pairStart - 1] : null;
    const above = pairStart + 2 < line.length ? line[pairStart + 2] : null;
    if (below) {
      if (below.coord > lo) lo = below.coord;
      impeders.push(below.point);
    }
    if (above) {
      if (above.coord < hi) hi = above.coord;
      impeders.push(above.point);
    }
  }
  return { lo, hi, impeders };
}

// A GRAPH-PRESERVING edit: move the named faces to `plane` along `axis` by
// rewriting only their vertices' coordinates. The graph itself — edges,
// faces, and the identity of every element — is carried forward BY REFERENCE,
// because a face move changes the drawing and nothing else.
//
// This is what makes the keys durable. Re-deriving the graph from the filled
// cubes would renumber the vertices (computeBrinkSkeleton sorts them
// lexicographically, and the moved ones sort differently), invalidating every
// key even though the graph is identical. Carrying it forward leaves each
// index exactly where it was.
//
// Returns null if the move would place two vertices at the same point: that
// is a graph-BREAKING merge, not something this path may quietly perform.
export function applyGraphDrawingEdit(skeleton, faceKeys, axis, plane) {
  const moved = new Set();
  for (const key of faceKeys) {
    const faceIdx = skeleton.byFaceKey.get(key);
    if (faceIdx === undefined) return null; // names a face this skeleton lacks
    for (const ei of skeleton.faces[faceIdx]) {
      for (const vi of skeleton.edges[ei]) moved.add(vi);
    }
  }

  const vertices = skeleton.vertices.map((p, vi) => {
    if (!moved.has(vi)) return [p[0], p[1], p[2]];
    const q = [p[0], p[1], p[2]];
    q[axis] = plane;
    return q;
  });

  // For the face-drag caller this is now belt-and-braces, and provably so:
  // computeAvailablePlanes only offers planes where the arriving cycle
  // touches nothing, and a coincident vertex is necessarily a touch. Every
  // vertex at coordinate `plane` has degree exactly 2 within that plane (see
  // brinkSkeleton.js's face construction), so it belongs to some resident
  // cycle the index tested; and a point shared with the arriving cycle is an
  // endpoint of an edge on BOTH sides, which is never the strictly-interior
  // proper crossing the interference rule permits. The check stays because it
  // is cheap, it guards the general multi-face signature, and a silent vertex
  // fusion would be unrecoverable.
  const distinct = new Set(vertices.map((p) => `${p[0]},${p[1]},${p[2]}`));
  if (distinct.size !== vertices.length) return null; // would fuse vertices

  return { ...skeleton, vertices };
}

