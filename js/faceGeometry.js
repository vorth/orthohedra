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

// --- Face-swapping drag ----------------------------------------------------
// A drag is a SEQUENCE OF DISCRETE STEPS, each moving the dragged face F to
// the next plane it can legally occupy and swapping back whatever was in the
// way. There is no continuous position: F's plane is always an integer, so the
// drawing is a legal configuration at every instant of the gesture.
//
// One step, moving F from plane P1 to a candidate plane P2, partitions each
// plane's residents by whether they interfere with F's in-plane footprint —
// the SAME footprint in both, since translating a face along its own normal
// leaves its 2D segments untouched:
//
//                    | interferes with F | doesn't
//   P1 (F's origin)  |   (empty)         |  A  stay-behinds
//   P2 (destination) |   B  swappers     |  C  bystanders
//
// F and B trade planes; A and C never move. P1's "interferes" cell is empty by
// INVARIANT — F occupies P1 legally, so nothing there interferes with it — and
// the step re-establishes that invariant, which is what makes steps composable.
//
// Legality reduces to ONE condition: A must not interfere with B.
//   - C is inert. P2 ends as C u {F}: C-vs-C is unchanged and C-vs-F is safe by
//     C's own definition. C never blocks anything.
//   - A u B is the only new pairing. A-vs-A and B-vs-B are unchanged (each set
//     already shared a plane legally), but A and B have never met.
// The asymmetry is structural: C is the set F JOINS, and C is defined by
// non-interference with F, so that pairing is safe by construction. A is the
// set B JOINS, and A is defined by its relationship to F, not to B — so it says
// nothing about how A and B relate. F is protected by definition; A and B meet
// unvetted.

// The faces resident in each plane normal to `axis`, keyed and prepared, plus
// the skeleton's vertex extent on that axis. Unlike buildPlaneFaceIndex this
// KEEPS the dragged face and every face's key, because a swapping drag has to
// move residents, not merely avoid them.
//
// The returned `index` is MUTATED as the drag steps (see applySwapStep): it is
// the drag's live model of which face sits in which plane, so that each step
// sees the arrangement the previous steps produced.
export function buildSwapPlaneIndex(skeleton, axis) {
  const index = new Map(); // plane coord -> [{ key, segs, bbox }]
  for (let faceIdx = 0; faceIdx < skeleton.faces.length; faceIdx++) {
    const projected = projectFace(skeleton, faceIdx, axis);
    if (!projected) continue; // normal to one of the other two axes
    if (!index.has(projected.coord)) index.set(projected.coord, []);
    const prepared = prepareFace(projected.segments);
    index.get(projected.coord).push({ key: skeleton.faceKeys[faceIdx], ...prepared });
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

// The residents of `plane` other than the dragged face, split into those that
// interfere with it and those that do not. Applied to F's own plane this yields
// { interfering: [], nonInterfering: A } by the invariant above; applied to a
// candidate it yields { interfering: B, nonInterfering: C }.
export function partitionResidents(index, plane, dragged, draggedKey) {
  const interfering = [];
  const nonInterfering = [];
  for (const resident of index.get(plane) ?? []) {
    if (resident.key === draggedKey) continue; // F is not a resident to avoid
    (facesInterfere(dragged, resident) ? interfering : nonInterfering).push(resident);
  }
  return { interfering, nonInterfering };
}

// Would any face in `a` interfere with any face in `b`? The step's whole
// legality test, applied to A and B.
export function setsInterfere(a, b) {
  for (const fa of a) {
    for (const fb of b) {
      if (facesInterfere(fa, fb)) return true;
    }
  }
  return false;
}

// --- Gate 1: vertex impedance ----------------------------------------------
// Independent of, and prior to, any swapping. A face's vertices travel along
// their own drag-axis lines, and each may pass its own collinear partner (that
// edge simply reverses) but no OTHER vertex on that line — doing so would make
// the edge overlap its neighbor. See dragBounds for the pairing argument; this
// is the same rule expressed as a per-face reach rather than as one interval
// around the dragged face.
//
// `vertexPositions` is the LIVE vertex array, which a swapping drag rewrites as
// it steps, so impedance is always measured against the current arrangement
// rather than the one the drag started in.

// Vertices grouped by the axis-parallel line they lie on, each list sorted
// along `axis`. Rebuilt per step: a step moves vertices, so a cached grouping
// would answer for a stale arrangement.
export function groupVerticesByLine(vertexPositions, axis) {
  const [ua, ub] = inPlaneAxes(axis);
  const byLine = new Map(); // "u,v" -> [{ coord, point }] sorted by coord
  for (const p of vertexPositions) {
    const k = `${p[ua]},${p[ub]}`;
    if (!byLine.has(k)) byLine.set(k, []);
    byLine.get(k).push({ coord: p[axis], point: p });
  }
  for (const arr of byLine.values()) arr.sort((a, b) => a.coord - b.coord);
  return byLine;
}

// The open interval (lo, hi) of edit-axis values the given vertices may move
// to, plus the barrier vertices themselves for highlighting. Same rule as
// dragBounds, but taking a prebuilt line grouping so a scan can reuse it, and
// taking vertex POSITIONS rather than a skeleton.
export function reachOnLines(byLine, axis, vertexIndices, vertexPositions) {
  const [ua, ub] = inPlaneAxes(axis);
  let lo = -Infinity;
  let hi = Infinity;
  const impeders = [];
  for (const vi of vertexIndices) {
    const p = vertexPositions[vi];
    const line = byLine.get(`${p[ua]},${p[ub]}`);
    if (!line) continue;
    // Locate the {V, W} pair on the line. Edges pair consecutive vertices
    // (1st-2nd, 3rd-4th, ...), so the pair's start index is even.
    const i = line.findIndex((e) => e.coord === p[axis]);
    if (i === -1) continue;
    const pairStart = i - (i % 2);
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

// --- The step: scan, skip, swap --------------------------------------------

// The skeleton vertex indices belonging to the named face.
export function faceVertexIndices(skeleton, faceKey) {
  const faceIdx = skeleton.byFaceKey.get(faceKey);
  if (faceIdx === undefined) return null;
  const indices = new Set();
  for (const ei of skeleton.faces[faceIdx]) {
    for (const vi of skeleton.edges[ei]) indices.add(vi);
  }
  return [...indices];
}

// Plan ONE step of a swapping drag: move F one plane in `dir` (+1/-1), or as
// far as the first plane it can legally occupy.
//
// SKIPPING. When A-vs-B blocks a candidate, the drag does NOT stop. That plane
// is dropped from consideration and the swap is retried against the next one
// out; the blocked plane keeps its contents and becomes an INERT LAYER F passes
// over. "Adjacent" was never the operative property — what a swap needs is that
// origin and destination be CONSECUTIVE AMONG THE PLANES F CAN LEGALLY OCCUPY.
//
// A skipped plane is inert as an OCCUPANCY question (no face enters or leaves
// it, so it contributes no pair to check) but live as a TRAVEL question: both
// F's forward vertices and B's backward vertices must clear it. B is what makes
// this matter — once a plane is skipped, B has to traverse an occupied plane to
// reach F's origin, which in the adjacent case it never did.
//
// B is recomputed per candidate. The scan is therefore not "find a legal plane"
// but "find a plane whose OWN interferers can survive in P1".
//
// Returns { plane, swapKeys, impeders } for the first legal candidate, or null
// when the scan is walled off (vertex impedance, or running out of model).
export function planSwapStep(skeleton, axis, draggedKey, dragged, index, dir, limits) {
  const { lo: modelLo, hi: modelHi } = limits;
  const fromPlane = planeOfFace(skeleton, axis, draggedKey);
  if (fromPlane === null) return null;

  const fVertices = faceVertexIndices(skeleton, draggedKey);
  if (!fVertices) return null;

  // A is fixed for the whole scan: it is what stays behind in F's own plane,
  // and no candidate changes it.
  const { nonInterfering: A } = partitionResidents(index, fromPlane, dragged, draggedKey);

  const byLine = groupVerticesByLine(skeleton.vertices, axis);
  // Gate 1 for F itself. F cannot travel past its own collinear neighbors no
  // matter which candidate it aims for, so this bounds the entire scan.
  const fReach = reachOnLines(byLine, axis, fVertices, skeleton.vertices);

  // Scan outward. The range is the model's extent plus headroom enough to pull
  // a face clear of the assembly, clamped to the world volume [MIN, MAX+1] that
  // a boundary face plane may occupy.
  const first = fromPlane + dir;
  const last = dir > 0 ? Math.min(modelHi + 3, MAX + 1) : Math.max(modelLo - 3, MIN);
  for (let plane = first; dir > 0 ? plane <= last : plane >= last; plane += dir) {
    // Gate 1, F: a hard wall. Beyond it no candidate is reachable, so the scan
    // ends rather than continuing past.
    if (!(plane > fReach.lo && plane < fReach.hi)) return null;

    const { interfering: B } = partitionResidents(index, plane, dragged, draggedKey);

    // Gate 2: the one condition. A blocked candidate is SKIPPED, not fatal.
    if (setsInterfere(A, B)) continue;

    // Gate 1, B: each swapper travels backward to F's plane, and once planes
    // have been skipped that path crosses occupied ground.
    let blocked = false;
    const swapKeys = [];
    for (const b of B) {
      const bVertices = faceVertexIndices(skeleton, b.key);
      if (!bVertices) {
        blocked = true;
        break;
      }
      const bReach = reachOnLines(byLine, axis, bVertices, skeleton.vertices);
      if (!(fromPlane > bReach.lo && fromPlane < bReach.hi)) {
        blocked = true;
        break;
      }
      swapKeys.push(b.key);
    }
    // A swapper that cannot make the trip blocks this candidate the same way an
    // A-vs-B collision does: skip it and try the next plane out.
    if (blocked) continue;

    return { plane, from: fromPlane, swapKeys, impeders: fReach.impeders };
  }
  return null; // ran out of model
}

// The edit-axis plane the named face currently lies in, or null if the face is
// not normal to `axis` (or is absent).
export function planeOfFace(skeleton, axis, faceKey) {
  const faceIdx = skeleton.byFaceKey.get(faceKey);
  if (faceIdx === undefined) return null;
  const projected = projectFace(skeleton, faceIdx, axis);
  return projected ? projected.coord : null;
}

// Apply a planned step: F to `plane`, its swappers back to `from`, in ONE
// rewrite of the vertex array. Both moves must happen together — applying them
// as two successive graph-preserving edits would pass through an intermediate
// state where F and B share a plane, which is exactly the interference the swap
// exists to resolve, and the coincident-vertex check would reject it.
//
// The graph — edges, faces, keys — is carried forward BY REFERENCE: a swap
// changes the drawing and nothing else. That is what makes the keys durable.
// Re-deriving the graph from the filled cubes would renumber the vertices
// (computeBrinkSkeleton sorts them lexicographically, and the moved ones sort
// differently), invalidating every key even though the graph is identical.
//
// Returns the new skeleton, or null if the move would fuse two vertices.
export function applySwapStep(skeleton, axis, draggedKey, step) {
  const { plane, from, swapKeys } = step;
  const forward = faceVertexIndices(skeleton, draggedKey);
  if (!forward) return null;
  const moved = new Map(); // vertex index -> its new edit-axis coordinate
  for (const vi of forward) moved.set(vi, plane);
  for (const key of swapKeys) {
    const backward = faceVertexIndices(skeleton, key);
    if (!backward) return null;
    for (const vi of backward) moved.set(vi, from);
  }

  const vertices = skeleton.vertices.map((p, vi) => {
    const q = [p[0], p[1], p[2]];
    if (moved.has(vi)) q[axis] = moved.get(vi);
    return q;
  });

  const distinct = new Set(vertices.map((p) => `${p[0]},${p[1]},${p[2]}`));
  if (distinct.size !== vertices.length) return null; // would fuse vertices

  return { ...skeleton, vertices };
}

// Move faces between planes in the drag's live plane index, mirroring what
// applySwapStep did to the skeleton. Keeping the index in step is what lets the
// NEXT step see the arrangement this one produced — the relabelling that makes
// a drag a repeated application of one local rule.
export function updateSwapIndex(index, step, draggedKey) {
  const { plane, from, swapKeys } = step;
  const moving = new Set([draggedKey, ...swapKeys]);
  const lifted = [];
  for (const [coord, residents] of index) {
    const keep = [];
    for (const resident of residents) {
      if (moving.has(resident.key)) lifted.push(resident);
      else keep.push(resident);
    }
    if (keep.length !== residents.length) index.set(coord, keep);
  }
  for (const resident of lifted) {
    const target = resident.key === draggedKey ? plane : from;
    if (!index.has(target)) index.set(target, []);
    index.get(target).push(resident);
  }
}
