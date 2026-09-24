// Pure geometry for custom face colors: given a brink-skeleton graph face's
// in-plane edges, find the unit boundary squares it "naively" encloses — its
// own edges as walls, jumping diagonally at its own self-crossings, blind to
// every other face. No three.js, no shared mutable state — same style as
// faceGeometry.js.
//
// A "square" is a unit cell in the plane, identified by its integer lower
// corner (u, v) (the same in-plane coordinates projectFace already uses).
// computeBoundaryCubeFaces guarantees at most one boundary face exists per
// (axis, coord, u, v) cell, so (u, v) alone is enough to key a square within
// one face's plane — no sign needed.

// One in-plane segment, normalized to { dir, fixed, s0, s1 } exactly like
// faceGeometry.js's normalizeSeg, then exploded into a set of UNIT steps: a
// brink-skeleton edge can span more than one grid unit when a straight run
// has no intermediate extremal vertex, but the fill walks one unit at a time,
// so every unit-length piece of that span is a wall in its own right.
function unitEdgeKey(u, v, dir) {
  // dir 0 = horizontal unit edge from (u,v) to (u+1,v); dir 1 = vertical unit
  // edge from (u,v) to (u,v+1).
  return `${u},${v},${dir}`;
}

// Build the set of unit edge keys covered by a face's in-plane segments.
function buildEdgeSet(segments) {
  const edges = new Set();
  for (const [au, av, bu, bv] of segments) {
    if (av === bv) {
      // Horizontal span at v = av, from min(au,bu) to max(au,bu).
      const lo = Math.min(au, bu);
      const hi = Math.max(au, bu);
      for (let u = lo; u < hi; u++) edges.add(unitEdgeKey(u, av, 0));
    } else {
      // Vertical span at u = au, from min(av,bv) to max(av,bv).
      const lo = Math.min(av, bv);
      const hi = Math.max(av, bv);
      for (let v = lo; v < hi; v++) edges.add(unitEdgeKey(au, v, 1));
    }
  }
  return edges;
}

// The 4 unit edges of square (u,v), each tagged with the neighboring square
// it separates from and the corner it would pivot around for a diagonal jump.
function squareEdges(u, v) {
  return [
    { key: unitEdgeKey(u, v, 0), neighbor: [u, v - 1], corner: null }, // bottom
    { key: unitEdgeKey(u, v + 1, 0), neighbor: [u, v + 1], corner: null }, // top
    { key: unitEdgeKey(u, v, 1), neighbor: [u - 1, v], corner: null }, // left
    { key: unitEdgeKey(u + 1, v, 1), neighbor: [u + 1, v], corner: null }, // right
  ];
}

// Find a seed square inside F, using the first two segments' shared vertex.
//
// A brink-skeleton VERTEX (as opposed to an incidental point where two
// edges merely cross, e.g. a figure-eight's pinch) is, by construction,
// always a point where exactly two ORTHOGONAL edges meet — never itself a
// crossing (see brinkSkeleton.js: a self-crossing point is explicitly NOT
// extremal, so it's never a vertex at all). So the first two segments of
// F's cycle — consecutive, hence sharing an endpoint — meet at a genuine
// vertex V, an ordinary corner, never a pinch.
//
// Of the 4 unit squares touching V, only 3 are legitimate seed candidates:
// the ONE truly walled off as F's interior there (bounded by BOTH on-F
// edges), and the TWO that each share exactly ONE of the two on-F edges
// with it (adjacent across a real wall, so at least we know something
// concrete about where they sit relative to F's boundary). The 4th —
// diagonally opposite the true interior — touches V only at that single
// point, sharing NEITHER on-F edge: its realness says nothing reliable
// about which side of F it's on (this is exactly what let a small
// inward-facing hole-loop's seed land outside it undetected before the
// bounding-box retry was added — excluding this quadrant here removes the
// bad case at the SOURCE, with the bbox retry as a second-line backstop
// for whichever of the 3 legitimate candidates turns out wrong).
//
// Returns { square, entryKey } — like every other square the walk visits,
// the seed needs an "entry edge" naming which of ITS on-F edges is the one
// it was found via, so the main walk's corner-vs-pinch test (which counts
// on-F edges AMONG THE NON-ENTRY ones) sees the seed's own ordinary corner
// at V the same way it sees every other plain corner in the walk — 1 on-F
// edge among the 3 non-entry ones is a wall, not a self-crossing. Without
// this, the seed looks like it has 2 on-F edges with nothing excluded,
// which the corner-vs-pinch test can't tell apart from a genuine pinch.
function seedSquare(segments, isBoundarySquare) {
  if (segments.length < 2) return null;
  const [a0, b0] = pointsOf(segments[0]);
  const [a1, b1] = pointsOf(segments[1]);
  const v = sharedPoint([a0, b0], [a1, b1]);
  if (!v) return null;
  const [vu, vv] = v;
  const edgeSet = buildEdgeSet(segments);

  // The 3 legitimate candidate quadrants: every square touching V whose
  // corner-at-V is bordered by at least one of V's two on-F edges (i.e.
  // shares an edge with V, not just the point) — excludes the diagonally-
  // opposite 4th quadrant, which shares neither.
  const candidates = [];
  for (const [u, sv] of [[vu - 1, vv - 1], [vu, vv - 1], [vu - 1, vv], [vu, vv]]) {
    const onFAtV = squareEdges(u, sv).filter((e) => edgeTouchesPoint(e.key, vu, vv) && edgeSet.has(e.key));
    if (onFAtV.length > 0) candidates.push({ square: [u, sv], edges: onFAtV });
  }

  for (const { square: [u, sv], edges } of candidates) {
    if (isBoundarySquare(u, sv)) return { square: [u, sv], entryKey: edges[0].key };
  }
  return null;
}

// Does unit edge `key` (from unitEdgeKey/squareEdges) have (pu,pv) as one of
// its two endpoints?
function edgeTouchesPoint(key, pu, pv) {
  const [eu, ev, dir] = key.split(',').map(Number);
  if (dir === 0) return (eu === pu || eu + 1 === pu) && ev === pv;
  return eu === pu && (ev === pv || ev + 1 === pv);
}

// The two endpoints of a segment, as [u,v] pairs.
function pointsOf([au, av, bu, bv]) {
  return [[au, av], [bu, bv]];
}

// The point shared by two segments' endpoint pairs (consecutive segments in
// a cycle always share exactly one), or null if none match.
function sharedPoint([p0, p1], [q0, q1]) {
  for (const p of [p0, p1]) {
    for (const q of [q0, q1]) {
      if (p[0] === q[0] && p[1] === q[1]) return p;
    }
  }
  return null;
}

/**
 * The naive interior of a face: a classical polygon interior using ONLY F's
 * own edges as walls (with diagonal jumps at F's own self-crossing corners),
 * blind to every other face's edges entirely — including where they'd carve
 * a "hole" out of F's interior via missing (non-boundary) squares. The fill
 * walks every unit cell inside F's polygon, real or not; realness is applied
 * only as a FINAL filter on the result, not as a gate during the walk.
 *
 * This matters for a face like a small notch's own boundary sitting right
 * next to (or fully surrounded by) another face's missing cells: if realness
 * gated the walk itself, a big ambient face's fill could be walled out of a
 * real square entirely by a moat of some OTHER face's holes on every
 * straight side, with no diagonal-jump mechanism to cross them (diagonal
 * jumps only fire at F's OWN self-crossings, not at a crossing between F's
 * distant boundary and some other face's nearby one). Filtering only at the
 * end avoids that: F's fill freely walks through what would-be-holes for
 * OTHER faces, because F's own boundary never told it to stop there.
 *
 * Bounded because F is a closed cycle: its own edges wall the fill in on
 * every side that isn't a self-crossing, regardless of what's real.
 * @param {Array<[number,number,number,number]>} segments - the face's
 *   in-plane edges, as returned by projectFace (au, av, bu, bv), all unit- or
 *   multi-unit-length axis-aligned spans.
 * @param {(u: number, v: number) => boolean} isBoundarySquare - whether a
 *   unit square in this plane is an actual rendered boundary face. Used to
 *   pick a genuinely-real seed, and to filter the final result — never to
 *   gate the walk itself.
 * @returns {Set<string>} keys "u,v" of every REAL square in F's interior.
 */
export function naiveFaceInterior(segments, isBoundarySquare) {
  const edgeSet = buildEdgeSet(segments);
  const vertexSet = buildVertexSet(segments);
  const bbox = buildBBox(segments);
  const seed = seedSquare(segments, isBoundarySquare);
  if (!seed) return new Set();

  // Which side of a vertex V is actually F's interior isn't always locally
  // decidable from realness/adjacency alone (e.g. a small inward-facing
  // loop like a hole's own boundary: the quadrant just outside the loop can
  // be just as real and just as edge-adjacent to V as the quadrant inside
  // it). Rather than solve that exactly, treat F's own bounding box as a
  // cheap, reliable backstop: F's true interior can never extend past it
  // (the box is built FROM F's own vertices), so a walk that visits
  // anything outside it has definitely started on the wrong side. Detect
  // that DURING the walk (not after — the whole point is to stop before
  // running away into the unbounded exterior), abandon it, and retry once
  // from the other side of the same starting edge.
  const attempt = (startSeed) => walkInterior(startSeed, edgeSet, vertexSet, bbox);
  let result = attempt(seed);
  if (result === null) {
    const [su, sv] = seed.square;
    const flipped = squareEdges(su, sv).find((e) => e.key === seed.entryKey);
    result = flipped ? attempt({ square: flipped.neighbor, entryKey: seed.entryKey }) : null;
  }
  if (result === null) return new Set(); // both sides ran outside the bbox: give up rather than hang

  // Realness is a final filter, not a walk-time gate (see doc comment above).
  const real = new Set();
  for (const squareKey of result) {
    const [u, v] = squareKey.split(',').map(Number);
    if (isBoundarySquare(u, v)) real.add(squareKey);
  }
  return real;
}

// One flood-fill attempt from a given seed. Returns the visited square-key
// set, or null if the walk stepped outside F's own bounding box (the caller
// retries from the seed's flip side in that case).
function walkInterior(seed, edgeSet, vertexSet, bbox) {
  const visited = new Set();
  const queue = [seed]; // { square, entryKey }

  while (queue.length) {
    const { square, entryKey } = queue.pop();
    const [u, v] = square;
    if (u < bbox.lo[0] || u > bbox.hi[0] || v < bbox.lo[1] || v > bbox.hi[1]) return null;
    const squareKey = `${u},${v}`;
    if (visited.has(squareKey)) continue;
    visited.add(squareKey);

    const edges = squareEdges(u, v);
    const onF = [];
    for (const edge of edges) {
      if (edge.key === entryKey) continue; // the edge we just crossed to get here
      if (edgeSet.has(edge.key)) {
        onF.push(edge);
      } else {
        queue.push({ square: edge.neighbor, entryKey: edge.key });
      }
    }

    // A pair of adjacent on-F edges meeting at a corner is EITHER an
    // ordinary turn in F's boundary (a real face VERTEX — ends/begins two
    // of F's segments there) or a genuine self-crossing pinch (the two
    // edges merely happen to meet at a point that is NOT a face vertex —
    // e.g. one or both are interior to a longer segment, or two separate
    // segments coincide there without the walk actually turning). Only the
    // pinch case jumps; an ordinary vertex is a plain wall on both sides,
    // same as any single on-F edge — the two edges together enclose exactly
    // one quadrant (this square's), walling the other 3 away from it, with
    // no diagonal path through a real corner.
    for (let i = 0; i < onF.length; i++) {
      for (let j = i + 1; j < onF.length; j++) {
        const corner = sharedCorner(u, v, onF[i], onF[j]);
        if (corner && !vertexSet.has(`${corner.point[0]},${corner.point[1]}`)) {
          queue.push({ square: corner.diagonal, entryKey: onF[i].key });
        }
      }
    }
  }

  return visited;
}

// F's 2D bounding box, in the SQUARE grid (not the vertex lattice): since a
// vertex at u=lo can only be the CORNER of a square at u=lo-1 or u=lo, the
// square-index box is [lo-1, hi] on each axis, one wider on the low side
// than the raw vertex bounds.
function buildBBox(segments) {
  const lo = [Infinity, Infinity];
  const hi = [-Infinity, -Infinity];
  for (const [au, av, bu, bv] of segments) {
    for (const [pu, pv] of [[au, av], [bu, bv]]) {
      if (pu < lo[0]) lo[0] = pu;
      if (pu > hi[0]) hi[0] = pu;
      if (pv < lo[1]) lo[1] = pv;
      if (pv > hi[1]) hi[1] = pv;
    }
  }
  return { lo: [lo[0] - 1, lo[1] - 1], hi };
}

// Do two of square (u,v)'s edges share a corner (i.e. are adjacent sides, not
// opposite/parallel ones)? If so, return the diagonal square across that
// corner AND the corner's own lattice point (for the vertex-vs-pinch test —
// see the walk above). Edges are tagged by which side they are via their
// neighbor offset relative to (u,v).
function sharedCorner(u, v, edgeA, edgeB) {
  const side = (edge) => {
    const [nu, nv] = edge.neighbor;
    if (nu === u && nv === v - 1) return 'bottom';
    if (nu === u && nv === v + 1) return 'top';
    if (nu === u - 1 && nv === v) return 'left';
    if (nu === u + 1 && nv === v) return 'right';
    return null;
  };
  const sa = side(edgeA);
  const sb = side(edgeB);
  const sides = new Set([sa, sb]);
  let diagonal = null;
  let point = null;
  if (sides.has('bottom') && sides.has('left')) { diagonal = [u - 1, v - 1]; point = [u, v]; }
  else if (sides.has('bottom') && sides.has('right')) { diagonal = [u + 1, v - 1]; point = [u + 1, v]; }
  else if (sides.has('top') && sides.has('left')) { diagonal = [u - 1, v + 1]; point = [u, v + 1]; }
  else if (sides.has('top') && sides.has('right')) { diagonal = [u + 1, v + 1]; point = [u + 1, v + 1]; }
  return diagonal ? { diagonal, point } : null;
}

// The set of F's own vertices — every segment endpoint, as "u,v" keys. A
// square corner that ISN'T one of these but is walled on two adjacent sides
// is a genuine self-crossing pinch, not an ordinary turn in the boundary
// (see brinkSkeleton.js: a self-crossing point is explicitly not extremal,
// so it never appears as a segment endpoint).
function buildVertexSet(segments) {
  const vertices = new Set();
  for (const [au, av, bu, bv] of segments) {
    vertices.add(`${au},${av}`);
    vertices.add(`${bu},${bv}`);
  }
  return vertices;
}

/**
 * Resolve, for every square claimed by at least one of `faces`, which face
 * owns it: whichever claiming face has the LARGEST naive interior overall
 * (not just at that square — its total footprint), first-encountered among
 * ties. This is a deliberate bias, not a disambiguation: a square can be
 * claimed by several faces with no way to always know which one a person
 * "meant" (e.g. a small face's own hole-boundary sits entirely inside a much
 * bigger face's naive interior — the big face is the ambient one, the small
 * face is a local notch cut into it, and the notch losing to the ambient
 * face is the useful bias, not a coincidence to special-case). No parity/XOR
 * cancellation: a square with any claimants gets an owner.
 * @param {Array<{ segments: Array }>} faces - candidate faces in one plane,
 *   each carrying at least `segments` (projectFace-style); callers attach
 *   whatever else they need (key, color) to read off the winner.
 * @param {(u: number, v: number) => boolean} isBoundarySquare - whether a
 *   unit square in this plane is an actual rendered boundary face.
 * @returns {Map<string, number>} square key "u,v" -> index into `faces` of
 *   its owner.
 */
export function resolveSquareOwners(faces, isBoundarySquare) {
  const interiors = faces.map((face) => naiveFaceInterior(face.segments, isBoundarySquare));
  const ownerIndex = new Map(); // "u,v" -> index into faces
  const ownerArea = new Map(); // "u,v" -> owner's interior.size
  for (let i = 0; i < interiors.length; i++) {
    const area = interiors[i].size;
    for (const squareKey of interiors[i]) {
      const bestArea = ownerArea.get(squareKey);
      if (bestArea === undefined || area > bestArea) {
        ownerArea.set(squareKey, area);
        ownerIndex.set(squareKey, i);
      }
    }
  }
  return ownerIndex;
}

/**
 * Resolve custom colors for every rendered square in one plane, given the
 * custom-colored faces that lie in it (see resolveSquareOwners for the
 * ownership rule).
 * @param {Array<{ key: string, color: string, segments: Array }>} coloredFaces
 *   - custom-colored faces in this plane, each with its faceKey, color, and
 *   projectFace-style segments.
 * @param {(u: number, v: number) => boolean} isBoundarySquare - whether a
 *   unit square in this plane is an actual rendered boundary face.
 * @returns {Map<string, string>} square key "u,v" -> resolved color.
 */
export function resolvePlaneColors(coloredFaces, isBoundarySquare) {
  const owners = resolveSquareOwners(coloredFaces, isBoundarySquare);
  const resolved = new Map();
  for (const [squareKey, i] of owners) resolved.set(squareKey, coloredFaces[i].color);
  return resolved;
}

/**
 * Click-time discovery: which candidate face owns the clicked square (see
 * resolveSquareOwners for the ownership rule)?
 * @param {Array<{ key: string, segments: Array }>} candidates - faces in the
 *   clicked square's plane.
 * @param {[number, number]} clickedSquare - [u, v] of the clicked square.
 * @param {(u: number, v: number) => boolean} isBoundarySquare - whether a
 *   unit square in this plane is an actual rendered boundary face.
 * @returns {string|null} the owning face's key, or null if none claim it.
 */
export function pickFaceForSquare(candidates, clickedSquare, isBoundarySquare) {
  const squareKey = `${clickedSquare[0]},${clickedSquare[1]}`;
  const owners = resolveSquareOwners(candidates, isBoundarySquare);
  const i = owners.get(squareKey);
  return i === undefined ? null : candidates[i].key;
}
