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
 * @returns {Array<{ cubeIndex: number, axis: number, sign: number, center: [number,number,number] }>}
 *   `center` is the face's geometric center in world coordinates.
 */
export function computeBoundaryCubeFaces(cubes) {
  const occupiedSet = new Set(cubes.map(({ x, y, z }) => `${x},${y},${z}`));
  function hasCube(x, y, z) {
    return occupiedSet.has(`${x},${y},${z}`);
  }

  const boundaryFaces = [];
  for (let cubeIndex = 0; cubeIndex < cubes.length; cubeIndex++) {
    const { x, y, z } = cubes[cubeIndex];
    for (const axis of AXES) {
      for (const sign of [-1, 1]) {
        const n = [x, y, z];
        n[axis] += sign;
        if (hasCube(n[0], n[1], n[2])) continue; // internal face between two present cubes
        // Cube center is least corner + 0.5 on each axis; the face is offset
        // half a unit further along `axis` in the `sign` direction.
        const center = [x + 0.5, y + 0.5, z + 0.5];
        center[axis] += sign / 2;
        boundaryFaces.push({ cubeIndex, axis, sign, center });
      }
    }
  }
  return boundaryFaces;
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

  // --- Element identity. -----------------------------------------------
  // Identity belongs to the GRAPH, which has no coordinates, so it must not be
  // derived from geometry: a graph-preserving edit moves vertices, and keys
  // derived from coordinates would be destroyed (or, in a plane swap, silently
  // exchanged) by exactly the operations that are supposed to preserve them.
  //
  // Here the ids are the freshly assigned vertex indices, which is correct for
  // a skeleton computed from cubes: this is the graph-BREAKING path, where the
  // cubes are ground truth and the graph is being (re)derived. The caller is
  // responsible for matching these back to previously issued ids — by
  // coordinate, legitimate precisely because coordinates are ground truth here.
  //
  // Edges are keyed by their endpoint ids; faces by their cycle of EDGE keys,
  // matching how faces are represented and persisted everywhere else (arrays of
  // edge indices), so nothing has to translate between vertex- and edge-shaped
  // notions of a face.
  const vertexIds = vertexPoints.map((_, vi) => vi);
  const edgeKeys = edges.map(([v1, v2]) => (v1 < v2 ? `${v1}|${v2}` : `${v2}|${v1}`));
  const faceKeys = faces.map((cycle) => canonicalCycleKey(cycle.map((ei) => edgeKeys[ei])));

  const byEdgeKey = new Map(edgeKeys.map((k, i) => [k, i]));
  const byFaceKey = new Map(faceKeys.map((k, i) => [k, i]));

  return {
    vertices: vertexPoints.map((p) => [p[0], p[1], p[2]]),
    edges,
    faces,
    vertexIds,
    edgeKeys,
    faceKeys,
    byEdgeKey,
    byFaceKey,
  };
}

export function logBrinkSkeleton(skeleton) {
  console.log('Brink skeleton:', {
    vertices: skeleton.vertices,
    edges: skeleton.edges,
    faces: skeleton.faces,
  });
}
