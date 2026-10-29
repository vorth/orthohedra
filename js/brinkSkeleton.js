// Computes the "brink skeleton" of a cube assembly: the mesh of vertices,
// edges, and faces traced along the boundary of the solid, where the
// boundary is defined by odd/even parity of cube occupancy:
//   - a vertex exists at a corner point touched by an odd number of the
//     (up to 8) cubes sharing it ("extremal");
//   - on each grid line (fixing two of the three coordinates), the
//     extremal vertices along that line, sorted by the varying
//     coordinate, pair up consecutively (1st-2nd, 3rd-4th, ...) into
//     brink-skeleton edges;
//   - on each grid plane (fixing one of the three coordinates), the
//     skeleton edges lying in that plane form a graph, via shared
//     vertices, where every vertex has degree exactly 2 (a vertex where
//     more than 2 coplanar edges met would require an even number of
//     cubes around it there, contradicting extremality) — so this graph
//     is a disjoint union of simple cycles, each one a face. Two faces
//     that only touch at a single point (not sharing an edge) do so at a
//     point that is not itself extremal, so the walk passes straight
//     through it without ambiguity — no orientation/winding is needed
//     anywhere in this construction.
//
// Convention: a cube is identified by its LEAST corner (its minimum-x,y,z
// corner) at integer coordinates. The unit cube with least corner (x,y,z)
// occupies [x,x+1] x [y,y+1] x [z,z+1], so its 8 corners are the integer
// points (x+dx, y+dy, z+dz) with dx,dy,dz in {0,1}. Skeleton vertices are
// therefore plain integer lattice points — no doubling or half-integers.

const AXES = [0, 1, 2];

// The 8 corner offsets of a unit cube, relative to its least corner.
const CORNER_OFFSETS = [];
for (const dx of [0, 1]) {
  for (const dy of [0, 1]) {
    for (const dz of [0, 1]) {
      CORNER_OFFSETS.push([dx, dy, dz]);
    }
  }
}

function pointKey(p) {
  return `${p[0]},${p[1]},${p[2]}`;
}

/**
 * Canonical key for a cycle of element keys. The cycle walk may start at any
 * element and run in either direction, so a face's key must be invariant to
 * both: rotate so the lowest-sorting key comes first, then take whichever of
 * the two directions gives the lexicographically smaller sequence.
 * @param {string[]} keys - the cycle's element keys, in cycle order
 * @returns {string}
 */
function canonicalCycleKey(keys) {
  const n = keys.length;
  if (n === 0) return '';
  let lowest = keys[0];
  for (const k of keys) if (k < lowest) lowest = k;

  let best = null;
  for (const seq of [keys, [...keys].reverse()]) {
    for (let start = 0; start < n; start++) {
      if (seq[start] !== lowest) continue;
      const rotated = [];
      for (let i = 0; i < n; i++) rotated.push(seq[(start + i) % n]);
      const candidate = rotated.join(',');
      if (best === null || candidate < best) best = candidate;
    }
  }
  return best;
}

/**
 * Compute the boundary (non-internal) unit faces of a cube assembly: one
 * entry per cube face that does not directly adjoin another cube (i.e.
 * every face except those sandwiched between two present cubes).
 * @param {Array<{x:number,y:number,z:number}>} cubes - integer least corners
 * @returns {Array<{ x:number, y:number, z:number, axis: number, sign: number, center: [number,number,number] }>}
 *   `x,y,z` is the owning cube's least corner; `center` is the face's
 *   geometric center in world coordinates.
 */
export function computeBoundaryCubeFaces(cubes) {
  const occupiedSet = new Set(cubes.map(({ x, y, z }) => `${x},${y},${z}`));
  function hasCube(x, y, z) {
    return occupiedSet.has(`${x},${y},${z}`);
  }

  const boundaryFaces = [];
  for (const { x, y, z } of cubes) {
    for (const axis of AXES) {
      for (const sign of [-1, 1]) {
        const n = [x, y, z];
        n[axis] += sign;
        if (hasCube(n[0], n[1], n[2])) continue; // internal face between two present cubes
        // Cube center is least corner + 0.5 on each axis; the face is offset
        // half a unit further along `axis` in the `sign` direction.
        const center = [x + 0.5, y + 0.5, z + 0.5];
        center[axis] += sign / 2;
        boundaryFaces.push({ x, y, z, axis, sign, center });
      }
    }
  }
  return boundaryFaces;
}

// --- Crossing defects. --------------------------------------------------
// A crossing defect is a lattice point where the surface is not locally a
// disk: two (or three) skeleton edges cross there, or an edge passes through
// the interior of a face. Like everything else here it is a parity rule over
// the (up to 8) cubes touching the point, so it is decided by a table over
// the 256 possible configurations.
//
// For a point that is NOT a vertex (even cube count), the unit segments on
// both sides of it along an axis have the same parity, and one is part of a
// skeleton edge iff an odd number of its 4 surrounding cubes are solid — so
// each axis has one bit saying "an edge passes straight through here".
// Likewise a unit square in a plane is a boundary square iff exactly one of
// its 2 cubes is solid. Then:
//   - edges through the point along 2 or 3 axes: an edge crossing (a triple
//     crossing counts once);
//   - an edge along exactly one axis c, with all 4 squares around the point
//     in the plane perpendicular to c being boundary squares: the edge
//     pierces a face.
// Faces overlapping within one plane cancel by parity, so an edge through a
// doubly-covered region is deliberately NOT detected.
//
// Configuration bit layout: the cube touching point p with least corner
// p - 1 + (dx,dy,dz), for dx,dy,dz in {0,1}, is bit dx*4 + dy*2 + dz.
function cornerBit(config, d) {
  return (config >> (d[0] * 4 + d[1] * 2 + d[2])) & 1;
}

function isCrossingDefectConfig(config) {
  let parity = 0;
  for (const d of CORNER_OFFSETS) parity ^= cornerBit(config, d);
  if (parity) return false; // odd count: a skeleton vertex

  // Edge through the point along each axis: parity of the 4 cubes on the +
  // side of the point along that axis.
  const edgeAxes = AXES.filter((axis) => {
    let p = 0;
    for (const d of CORNER_OFFSETS) if (d[axis] === 1) p ^= cornerBit(config, d);
    return p === 1;
  });
  if (edgeAxes.length >= 2) return true; // edge crossing (or triple crossing)
  if (edgeAxes.length === 0) return false;

  // One edge, along `axis`: it pierces a face iff every column of 2 cubes
  // along `axis` has exactly one solid, i.e. all 4 squares around the point
  // in the perpendicular plane are boundary squares.
  const axis = edgeAxes[0];
  return CORNER_OFFSETS.filter((d) => d[axis] === 0).every((d) => {
    const other = [...d];
    other[axis] = 1;
    return (cornerBit(config, d) ^ cornerBit(config, other)) === 1;
  });
}

const CROSSING_DEFECT_CONFIG = Uint8Array.from({ length: 256 }, (_, config) => (isCrossingDefectConfig(config) ? 1 : 0));

/**
 * Find the crossing defects of a cube assembly (see above).
 * @param {Array<{x:number,y:number,z:number}>} cubes - integer least corners
 * @returns {Array<[number,number,number]>} defect lattice points
 */
export function computeCrossingDefects(cubes) {
  if (cubes.length === 0) return [];

  // Dense grid over the cubes' bounding box padded by one cube on each side,
  // so every corner point's 8 touching cells are in range. Only corners of
  // solid cubes can be defects, so visit just those, once each.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const { x, y, z } of cubes) {
    const c = [x, y, z];
    for (const k of AXES) {
      if (c[k] < lo[k]) lo[k] = c[k];
      if (c[k] > hi[k]) hi[k] = c[k];
    }
  }
  const origin = lo.map((v) => v - 1);
  const size = AXES.map((k) => hi[k] - lo[k] + 3);
  const idx = (x, y, z) => ((x - origin[0]) * size[1] + (y - origin[1])) * size[2] + (z - origin[2]);
  const solid = new Uint8Array(size[0] * size[1] * size[2]);
  for (const { x, y, z } of cubes) solid[idx(x, y, z)] = 1;

  const seen = new Uint8Array(solid.length); // indexed by corner point
  const defects = [];
  for (const { x, y, z } of cubes) {
    for (const o of CORNER_OFFSETS) {
      const px = x + o[0];
      const py = y + o[1];
      const pz = z + o[2];
      const pi = idx(px, py, pz);
      if (seen[pi]) continue;
      seen[pi] = 1;
      let config = 0;
      for (const d of CORNER_OFFSETS) {
        if (solid[idx(px - 1 + d[0], py - 1 + d[1], pz - 1 + d[2])]) {
          config |= 1 << (d[0] * 4 + d[1] * 2 + d[2]);
        }
      }
      if (CROSSING_DEFECT_CONFIG[config]) defects.push([px, py, pz]);
    }
  }
  return defects;
}

/**
 * Compute the brink skeleton of a cube assembly.
 * @param {Array<{x:number,y:number,z:number}>} cubes - integer least corners
 * @returns {{
 *   vertices: Array<[number,number,number]>,
 *   edges: Array<[number,number]>,
 *   faces: Array<number[]>
 * }}
 */
export function computeBrinkSkeleton(cubes) {
  // --- Dimension 0: vertices = corner points touched by an odd number of cubes. ---
  const cornerCounts = new Map(); // pointKey -> count
  for (const { x, y, z } of cubes) {
    for (const offset of CORNER_OFFSETS) {
      const p = [x + offset[0], y + offset[1], z + offset[2]];
      const k = pointKey(p);
      cornerCounts.set(k, (cornerCounts.get(k) || 0) + 1);
    }
  }

  const vertexPoints = []; // integer lattice coords
  for (const [k, count] of cornerCounts) {
    if (count % 2 === 1) {
      vertexPoints.push(k.split(',').map(Number));
    }
  }

  // Sort lexicographically by (x, y, z). `cornerCounts` is keyed by insertion
  // order over `cubes`, which callers reorder freely (removeVoxel swap-pops),
  // so without this the index assigned to a vertex depends on the history of
  // the cube array rather than on the vertex set itself. Sorting makes indexing
  // a deterministic function of the SET, so two equal cube assemblies always
  // produce identically indexed skeletons — which is what lets a Gb recompute
  // match its new vertices back to existing identities reproducibly.
  vertexPoints.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

  // --- Dimension 1: edges. Group extremal vertices by the line they sit
  // on (the 2 fixed coordinates), sort each line by the varying
  // coordinate, and pair up consecutive vertices: 1st-2nd, 3rd-4th, ... ---
  const edges = []; // [vertexIdx, vertexIdx]
  const edgeIndex = new Map(); // "v1|v2" (sorted numerically) -> edge index
  function getOrCreateEdge(v1, v2) {
    const k = v1 < v2 ? `${v1}|${v2}` : `${v2}|${v1}`;
    let idx = edgeIndex.get(k);
    if (idx === undefined) {
      idx = edges.length;
      edges.push([v1, v2]);
      edgeIndex.set(k, idx);
    }
    return idx;
  }

  for (const axis of AXES) {
    const otherAxes = AXES.filter((a) => a !== axis);
    const byLine = new Map(); // "fixedU,fixedV" -> [{vertexIdx, t}]
    for (let vi = 0; vi < vertexPoints.length; vi++) {
      const p = vertexPoints[vi];
      const lineKey = `${p[otherAxes[0]]},${p[otherAxes[1]]}`;
      if (!byLine.has(lineKey)) byLine.set(lineKey, []);
      byLine.get(lineKey).push({ vertexIdx: vi, t: p[axis] });
    }
    for (const onLine of byLine.values()) {
      onLine.sort((a, b) => a.t - b.t);
      for (let i = 0; i + 1 < onLine.length; i += 2) {
        getOrCreateEdge(onLine[i].vertexIdx, onLine[i + 1].vertexIdx);
      }
    }
  }

  // --- Dimension 2: faces. Group skeleton edges by each plane they lie
  // in (an edge along `axis` lies in the 2 planes fixing each of the
  // other 2 coordinates). Within one plane, every vertex has degree
  // exactly 2 among that plane's edges, so the edge set is a disjoint
  // union of simple cycles — walk each one to find the faces. ---
  const edgesByPlane = new Map(); // "planeAxis=fixedCoord" -> Set(edgeIdx)
  for (let edgeIdx = 0; edgeIdx < edges.length; edgeIdx++) {
    const [v1, v2] = edges[edgeIdx];
    const p1 = vertexPoints[v1];
    const p2 = vertexPoints[v2];
    const axis = AXES.find((a) => p1[a] !== p2[a]);
    for (const planeAxis of AXES.filter((a) => a !== axis)) {
      const planeKey = `${planeAxis}=${p1[planeAxis]}`;
      if (!edgesByPlane.has(planeKey)) edgesByPlane.set(planeKey, new Set());
      edgesByPlane.get(planeKey).add(edgeIdx);
    }
  }

  function otherEndpoint([v1, v2], from) {
    return v1 === from ? v2 : v1;
  }

  const faces = [];
  for (const edgeSet of edgesByPlane.values()) {
    const adjacency = new Map(); // vertexIdx -> [edgeIdx, ...] (unused incident edges in this plane)
    for (const edgeIdx of edgeSet) {
      const [v1, v2] = edges[edgeIdx];
      if (!adjacency.has(v1)) adjacency.set(v1, []);
      if (!adjacency.has(v2)) adjacency.set(v2, []);
      adjacency.get(v1).push(edgeIdx);
      adjacency.get(v2).push(edgeIdx);
    }

    const visitedEdges = new Set();
    for (const startVertex of adjacency.keys()) {
      for (const startEdge of adjacency.get(startVertex)) {
        if (visitedEdges.has(startEdge)) continue;

        const cycleEdgeIdxs = [startEdge];
        visitedEdges.add(startEdge);
        let currVertex = otherEndpoint(edges[startEdge], startVertex);

        while (currVertex !== startVertex) {
          const candidates = adjacency.get(currVertex);
          const nextEdge = candidates.find((ei) => !visitedEdges.has(ei));
          visitedEdges.add(nextEdge);
          cycleEdgeIdxs.push(nextEdge);
          currVertex = otherEndpoint(edges[nextEdge], currVertex);
        }

        if (cycleEdgeIdxs.length >= 3) faces.push(cycleEdgeIdxs);
      }
    }
  }

  return {
    vertices: vertexPoints.map((p) => [p[0], p[1], p[2]]),
    edges,
    faces,
    ...keySkeleton(edges, faces),
  };
}

// --- Element identity. -----------------------------------------------
// Identity belongs to the GRAPH, which has no coordinates, so it must not be
// derived from geometry: a graph-preserving edit moves vertices, and keys
// derived from coordinates would be destroyed (or, in a plane swap, silently
// exchanged) by exactly the operations that are supposed to preserve them.
//
// Assigns keys purely from an edges/faces STRUCTURE (edges as vertex-index
// pairs, faces as edge-index cycles) — no coordinates, no cube history.
// computeBrinkSkeleton calls this on the vertex indices it just assigned via
// its lexicographic sort, which is correct for a skeleton computed FROM
// CUBES: this is the graph-BREAKING path, where the cubes are ground truth
// and the graph is being (re)derived, so a fresh sort-then-key pass here is
// exactly the deterministic, content-derived identity the "two equal cube
// assemblies always produce identically indexed skeletons" guarantee needs.
//
// A CONCRETE skeleton loaded from a save file (vertices/edges/faces already
// fully known, no cubes involved) should call this DIRECTLY on its own
// edges/faces — never bounce through computeBrinkSkeleton(fillCubesFromSkeleton(...))
// to get keys, which would silently re-derive a DIFFERENT vertex ordering
// (and hence different keys) than the one actually saved, for no reason:
// the graph is already fully known, so its identity is exactly this
// function's output on the data as given, full stop.
//
// Edges are keyed by their endpoint ids; faces by their cycle of EDGE keys,
// matching how faces are represented and persisted everywhere else (arrays of
// edge indices), so nothing has to translate between vertex- and edge-shaped
// notions of a face.
//
// Keys are durable IDENTITY, not a canonical function of the drawing. A
// graph-preserving edit carries them forward unchanged, so they keep naming
// the same elements across a session's edits — but they are not what a fresh
// computeBrinkSkeleton call would assign to the edited drawing, since its
// lexicographic sort would number moved vertices differently. Two skeletons
// of the same shape may therefore carry different keys if one was produced
// by re-deriving from cubes and the other wasn't: use keys to track elements
// through history, and compare COORDINATES to ask whether two graphs match.
export function keySkeleton(edges, faces) {
  const edgeKeys = edges.map(([v1, v2]) => (v1 < v2 ? `${v1}|${v2}` : `${v2}|${v1}`));
  const faceKeys = faces.map((cycle) => canonicalCycleKey(cycle.map((ei) => edgeKeys[ei])));

  const byEdgeKey = new Map(edgeKeys.map((k, i) => [k, i]));
  const byFaceKey = new Map(faceKeys.map((k, i) => [k, i]));

  return { edgeKeys, faceKeys, byEdgeKey, byFaceKey };
}

// edgeIdx -> [faceIdx, ...]: the share-an-edge face adjacency, built once and
// reusable across many component walks over the same skeleton.
function buildFacesByEdge(faces) {
  const facesByEdge = new Map();
  for (let faceIdx = 0; faceIdx < faces.length; faceIdx++) {
    for (const edgeIdx of faces[faceIdx]) {
      if (!facesByEdge.has(edgeIdx)) facesByEdge.set(edgeIdx, []);
      facesByEdge.get(edgeIdx).push(faceIdx);
    }
  }
  return facesByEdge;
}

// Flood-fill the face adjacency from `startFaceIdx`, returning the set of
// GLOBAL face indices in that component.
function walkComponentFaces(faces, facesByEdge, startFaceIdx) {
  const visitedFaces = new Set([startFaceIdx]);
  const queue = [startFaceIdx];
  while (queue.length > 0) {
    const faceIdx = queue.pop();
    for (const edgeIdx of faces[faceIdx]) {
      for (const neighborFaceIdx of facesByEdge.get(edgeIdx)) {
        if (visitedFaces.has(neighborFaceIdx)) continue;
        visitedFaces.add(neighborFaceIdx);
        queue.push(neighborFaceIdx);
      }
    }
  }
  return visitedFaces;
}

// Repackage a set of global face indices as a standalone skeleton, remapping
// vertex/edge indices into a dense local range starting at 0.
function skeletonFromFaceSet(skeleton, faceIndices) {
  const { vertices, edges, faces } = skeleton;
  const visitedFaces = faceIndices;

  // Collect this component's edges and vertices, then remap to dense local
  // indices so the returned skeleton is self-contained.
  const localEdgeIdx = new Map(); // global edgeIdx -> local edgeIdx
  const localVertexIdx = new Map(); // global vertexIdx -> local vertexIdx
  const outVertices = [];
  const outEdges = [];

  function remapVertex(globalVi) {
    let local = localVertexIdx.get(globalVi);
    if (local === undefined) {
      local = outVertices.length;
      localVertexIdx.set(globalVi, local);
      outVertices.push(vertices[globalVi]);
    }
    return local;
  }

  function remapEdge(globalEi) {
    let local = localEdgeIdx.get(globalEi);
    if (local === undefined) {
      const [v1, v2] = edges[globalEi];
      local = outEdges.length;
      localEdgeIdx.set(globalEi, local);
      outEdges.push([remapVertex(v1), remapVertex(v2)]);
    }
    return local;
  }

  const outFaces = [];
  for (const faceIdx of visitedFaces) {
    outFaces.push(faces[faceIdx].map(remapEdge));
  }

  return { vertices: outVertices, edges: outEdges, faces: outFaces };
}

// The connected component of brink-skeleton FACES reachable from
// `startFaceIdx`, where two faces are adjacent iff they share an edge index.
// Every skeleton edge belongs to exactly two faces (it sits in the two grid
// planes perpendicular to the other two axes, each contributing one face
// cycle — see computeBrinkSkeleton's "Dimension 2" pass), so "shares an
// edge" is a well-defined, symmetric adjacency between whole faces.
//
// Returns a fresh standalone skeleton — {vertices, edges, faces} — holding
// only the component's own faces, with vertex/edge indices remapped to a
// dense local range starting at 0. Because a connected set of whole face
// cycles can never include a "partial" face, every included edge's plane
// still decomposes into complete cycles exactly as it did in the full
// skeleton, so this remains a valid brink skeleton in its own right — safe
// to pass directly to fillCubesFromSkeleton to recover just the cubes behind
// this one connected patch of surface.
export function skeletonComponentFromFace(skeleton, startFaceIdx) {
  const facesByEdge = buildFacesByEdge(skeleton.faces);
  const faceSet = walkComponentFaces(skeleton.faces, facesByEdge, startFaceIdx);
  return skeletonFromFaceSet(skeleton, faceSet);
}

// Partition a skeleton into its connected components, using the same
// share-an-edge face adjacency as skeletonComponentFromFace. Returns an array
// of standalone skeletons, one per component, each with its own dense
// vertex/edge indices — so every component can be measured (or filled)
// exactly as if it were the whole skeleton.
//
// Components come out in order of their lowest-numbered face, which makes the
// ordering stable across recomputation for an unchanged design: face indices
// derive from the sorted grid traversal in computeBrinkSkeleton, not from any
// traversal order here.
export function skeletonComponents(skeleton) {
  const { faces } = skeleton;
  const facesByEdge = buildFacesByEdge(faces);

  // Faces already claimed by an earlier component, so each component is
  // walked exactly once no matter how many faces it has.
  const seen = new Set();
  const components = [];
  for (let faceIdx = 0; faceIdx < faces.length; faceIdx++) {
    if (seen.has(faceIdx)) continue;
    const faceSet = walkComponentFaces(faces, facesByEdge, faceIdx);
    for (const globalFaceIdx of faceSet) seen.add(globalFaceIdx);
    components.push(skeletonFromFaceSet(skeleton, faceSet));
  }
  return components;
}

export function logBrinkSkeleton(skeleton) {
  console.log('Brink skeleton:', {
    vertices: skeleton.vertices,
    edges: skeleton.edges,
    faces: skeleton.faces,
  });
}
