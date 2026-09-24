// Tests for js/faceColoring.js: the naive per-face flood-fill and the
// largest-area-wins square ownership rule. Plain Node ESM, no framework or
// dependency — run directly with `node tests/faceColoring.test.mjs`.
//
// Every geometry here is derived from REAL cube positions through the actual
// app pipeline (computeBrinkSkeleton, computeBoundaryCubeFaces, projectFace)
// rather than hand-written segment lists: a hand-built face cycle can easily
// describe geometry no real cube assembly would ever produce (this bit once
// — a fabricated figure-eight test ran away into an infinite fill because
// it wasn't a legitimate brink-skeleton face). The one exception is the
// equal-area-tie case, which tests resolvePlaneColors's tie-break policy in
// isolation and is explicitly documented as synthetic where it appears.

import { computeBrinkSkeleton, computeBoundaryCubeFaces } from '../js/brinkSkeleton.js';
import { projectFace, inPlaneAxes } from '../js/faceGeometry.js';
import {
  naiveFaceInterior,
  resolvePlaneColors,
  pickFaceForSquare,
  resolveSquareOwners,
} from '../js/faceColoring.js';

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('ok:', msg);
  } else {
    failures++;
    console.error('FAILED:', msg);
  }
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// Derive all faces (with segments) normal to `axis`, plus an
// isBoundarySquareAt(coord) predicate factory, from real cube positions via
// the actual app pipeline.
function deriveAxisData(positions, axis) {
  const skeleton = computeBrinkSkeleton(positions);
  const boundaryFaces = computeBoundaryCubeFaces(positions);
  const [ua, ub] = inPlaneAxes(axis);

  const boundarySet = new Set();
  for (const bf of boundaryFaces) {
    if (bf.axis !== axis) continue;
    const coord = Math.round(bf.center[axis]);
    const u = Math.round(bf.center[ua] - 0.5);
    const v = Math.round(bf.center[ub] - 0.5);
    boundarySet.add(`${coord},${u},${v}`);
  }
  const isBoundarySquareAt = (coord) => (u, v) => boundarySet.has(`${coord},${u},${v}`);

  const faces = [];
  for (let i = 0; i < skeleton.faces.length; i++) {
    const projected = projectFace(skeleton, i, axis);
    if (projected) faces.push({ key: skeleton.faceKeys[i], coord: projected.coord, segments: projected.segments });
  }
  return { faces, isBoundarySquareAt };
}

// --- Single cube: one face per axis, unit square interior -----------------
{
  const positions = [{ x: 0, y: 0, z: 0 }];
  const { faces, isBoundarySquareAt } = deriveAxisData(positions, 2);
  assert(faces.length === 2, 'single cube: 2 faces normal to z (top+bottom)');
  for (const f of faces) {
    const interior = naiveFaceInterior(f.segments, isBoundarySquareAt(f.coord));
    assert(setsEqual(interior, new Set(['0,0'])), `single cube face at coord=${f.coord}: interior = {(0,0)}`);
  }
}

// --- 2x2x1 slab: one face per axis (top), 4 unit squares -------------------
{
  const positions = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 1, y: 1, z: 0 },
  ];
  const { faces, isBoundarySquareAt } = deriveAxisData(positions, 2);
  const top = faces.find((f) => f.coord === 1);
  assert(Boolean(top), '2x2 slab: top face exists at z=1');
  const interior = naiveFaceInterior(top.segments, isBoundarySquareAt(1));
  assert(
    setsEqual(interior, new Set(['0,0', '1,0', '0,1', '1,1'])),
    '2x2 slab top face interior = 4 unit squares'
  );
}

// --- Plus-sign footprint (5 cubes), single connected face ------------------
{
  const positions = [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 1, y: 1, z: 0 },
    { x: 2, y: 1, z: 0 },
    { x: 1, y: 2, z: 0 },
  ];
  const { faces, isBoundarySquareAt } = deriveAxisData(positions, 2);
  const top = faces.filter((f) => f.coord === 1);
  assert(top.length === 1, 'plus-footprint: exactly one top face (single connected region)');
  const interior = naiveFaceInterior(top[0].segments, isBoundarySquareAt(1));
  assert(
    setsEqual(interior, new Set(['1,0', '0,1', '1,1', '2,1', '1,2'])),
    'plus-footprint: interior covers all 5 unit squares'
  );
}

// --- Ring with a hole: outer boundary face + inner hole-boundary face ------
// A 3x3 slab with the center cube missing produces TWO face cycles: the
// OUTER boundary (naive interior = the 8-square ring) and the INNER
// hole-boundary (a tiny loop around the missing center cell) -- whose naive
// interior is just the one square it encloses, (1,1), which isn't real
// (the center cube is missing), so after the realness filter it's EMPTY.
// That's correct, not a bug: a hole-boundary face that encloses nothing but
// missing cells legitimately owns no squares at all.
{
  const positions = [];
  for (let x = 0; x <= 2; x++) {
    for (let y = 0; y <= 2; y++) {
      if (x === 1 && y === 1) continue; // hole
      positions.push({ x, y, z: 0 });
    }
  }
  const { faces, isBoundarySquareAt } = deriveAxisData(positions, 2);
  const top = faces.filter((f) => f.coord === 1);
  assert(top.length === 2, 'ring-with-hole: exactly 2 faces (outer boundary + inner hole boundary)');
  const sizes = top.map((f) => naiveFaceInterior(f.segments, isBoundarySquareAt(1)).size);
  assert(sizes.includes(8), 'ring-with-hole: one face is the outer boundary (interior size 8)');
  assert(sizes.includes(0), 'ring-with-hole: the other is the inner hole boundary (interior size 0, encloses only the missing cell)');
  const outer = top.find((f) => naiveFaceInterior(f.segments, isBoundarySquareAt(1)).size === 8);
  {
    const interior = naiveFaceInterior(outer.segments, isBoundarySquareAt(1));
    assert(
      setsEqual(interior, new Set(['0,0', '0,1', '0,2', '1,0', '1,2', '2,0', '2,1', '2,2'])),
      `ring-with-hole outer face: interior = the 8-square ring`
    );
  }
}

// --- pickFaceForSquare on real data -----------------------------------------
{
  const positions = [
    { x: 0, y: 0, z: 0 },
    { x: 5, y: 5, z: 5 },
  ];
  const { faces, isBoundarySquareAt } = deriveAxisData(positions, 2);
  const candidates = faces.filter((f) => f.coord === 1);
  const found = pickFaceForSquare(candidates, [0, 0], isBoundarySquareAt(1));
  assert(found !== null, 'pickFaceForSquare finds a face for (0,0)');
  const interior0 = naiveFaceInterior(
    candidates.find((f) => f.key === found).segments,
    isBoundarySquareAt(1)
  );
  assert(interior0.has('0,0'), 'pickFaceForSquare result actually contains (0,0)');

  const notFound = pickFaceForSquare(candidates, [99, 99], isBoundarySquareAt(1));
  assert(notFound === null, 'pickFaceForSquare returns null when no match');
}

// --- Real figure-eight self-crossing (two diagonally-touching cubes) -------
{
  const positions = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 1, z: 0 },
  ];
  const { faces, isBoundarySquareAt } = deriveAxisData(positions, 2);
  const top = faces.filter((f) => f.coord === 1);
  assert(top.length === 1, 'diagonal-touch cubes: ONE face cycle (self-crossing), not two');
  const interior = naiveFaceInterior(top[0].segments, isBoundarySquareAt(1));
  assert(setsEqual(interior, new Set(['0,0', '1,1'])), 'figure-eight interior = both diagonal squares, via jump');
}

// --- Real overlapping-faces layout (10-cube construction) -------------------
// Two coplanar graph faces whose naive interiors would geometrically cross at
// unit cell (1,1) -- but that exact cell is excluded upstream by cube parity
// (it's never a rendered boundary square in this particular layout), so the
// two naive interiors come out disjoint. See resolveSquareOwners for what
// happens when two interiors DO share a real square.
{
  const positions = [
    { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 2, z: 0 }, { x: 0, y: 2, z: 1 },
    { x: 1, y: 0, z: 0 }, { x: 1, y: 2, z: 1 }, { x: 2, y: 0, z: 0 }, { x: 2, y: 0, z: 1 },
    { x: 2, y: 1, z: 1 }, { x: 2, y: 2, z: 1 },
  ];
  const { faces, isBoundarySquareAt } = deriveAxisData(positions, 2);
  const atCoord1 = faces.filter((f) => f.coord === 1);
  assert(atCoord1.length === 2, 'overlap layout: exactly two distinct faces at coord=1');

  const [faceA, faceB] = atCoord1;
  const interiorA = naiveFaceInterior(faceA.segments, isBoundarySquareAt(1));
  const interiorB = naiveFaceInterior(faceB.segments, isBoundarySquareAt(1));
  const overlap = [...interiorA].filter((k) => interiorB.has(k));
  assert(overlap.length === 0, 'naive interiors are disjoint once parity has already excluded the crossing cell');
  assert(!isBoundarySquareAt(1)(1, 1), 'the geometric crossing cell (1,1) is not a real boundary square');

  const resolved = resolvePlaneColors(
    [
      { key: faceA.key, color: 'magenta', segments: faceA.segments },
      { key: faceB.key, color: 'cyan', segments: faceB.segments },
    ],
    isBoundarySquareAt(1)
  );
  for (const cell of interiorA) assert(resolved.get(cell) === 'magenta', `A cell ${cell} colored magenta`);
  for (const cell of interiorB) assert(resolved.get(cell) === 'cyan', `B cell ${cell} colored cyan`);
}

// --- Plus-sign HOLE: outer face should own a square naively claimed by two
// much-smaller inset faces too (largest-naive-interior-wins) -------------
// A 5x5x1 slab with a plus-shaped hole (4 cells removed: both ends of a
// horizontal and a vertical 3-cube arm through the center), leaving the
// center cube filled by parity. Three faces share the top plane: the 5x5
// outer perimeter, and the two small arm-notch rectangles (3x1 and 1x3) --
// all three naively contain the center square. The outer face must win: it
// is the "ambient" face the two small notches are cut into, not a peer
// competing on equal footing.
{
  const removed = new Set(['1,2,0', '3,2,0', '2,1,0', '2,3,0']);
  const positions = [];
  for (let x = 0; x < 5; x++) {
    for (let y = 0; y < 5; y++) {
      const k = `${x},${y},0`;
      if (!removed.has(k)) positions.push({ x, y, z: 0 });
    }
  }
  assert(positions.length === 21, 'plus-hole setup: 21 cubes present');

  const { faces, isBoundarySquareAt } = deriveAxisData(positions, 2);
  const atCoord1 = faces.filter((f) => f.coord === 1);
  assert(atCoord1.length === 3, `plus-hole: exactly 3 faces at coord=1, found ${atCoord1.length}`);
  assert(isBoundarySquareAt(1)(2, 2), 'plus-hole: center square (2,2) is a real boundary square');

  const sizes = atCoord1.map((f) => naiveFaceInterior(f.segments, isBoundarySquareAt(1)).size);
  const outerIdx = sizes.indexOf(Math.max(...sizes));
  assert(sizes[outerIdx] === 21, 'plus-hole: the outer face naive interior is all 21 solid squares');
  // Each small arm-face's own 3x1 (or 1x3) rectangle spans one real center
  // square and two REMOVED end cells -- those two aren't real boundary
  // squares, so after the realness filter each small face's naive interior
  // is just the 1 real square it actually encloses, not all 3.
  assert(
    sizes.filter((s) => s === 1).length === 2,
    'plus-hole: the two inset arm faces each have a naive interior of 1 square (their 2 removed end-cells are filtered out as unreal)'
  );

  const owners = resolveSquareOwners(atCoord1, isBoundarySquareAt(1));
  assert(
    owners.get('2,2') === outerIdx,
    'plus-hole: the center square is owned by the largest (outer) face, not either small inset face'
  );

  const clickedKey = pickFaceForSquare(atCoord1, [2, 2], isBoundarySquareAt(1));
  assert(clickedKey === atCoord1[outerIdx].key, 'plus-hole: pickFaceForSquare resolves the center click to the outer face');

  const colored = atCoord1.map((f, i) => ({ ...f, color: `color${i}` }));
  const resolved = resolvePlaneColors(colored, isBoundarySquareAt(1));
  assert(
    resolved.get('2,2') === `color${outerIdx}`,
    'plus-hole: resolvePlaneColors colors the center square with the outer face color'
  );
}

// --- Synthetic equal-area tie: first-encountered wins ----------------------
// SYNTHETIC (not cube-derived): two simple, non-self-crossing rectangles of
// EQUAL naive-interior size (3 squares each), crossing in a plus shape, with
// every square in the 3x3 grid declared a real boundary square by fiat --
// modeling a hypothetical solid where the crossing cell genuinely IS
// double-covered (unlike the real 10-cube example above, where parity
// happened to already exclude it). This isolates resolveSquareOwners's
// tie-break policy: when areas are exactly equal, there is no principled
// winner, so the first-encountered face wins as a deliberate, accepted bias.
{
  const allReal = new Set();
  for (let u = 0; u < 3; u++) for (let v = 0; v < 3; v++) allReal.add(`${u},${v}`);
  const isBoundarySquare = (u, v) => allReal.has(`${u},${v}`);

  const segA = [[0, 1, 3, 1], [3, 1, 3, 2], [3, 2, 0, 2], [0, 2, 0, 1]]; // horizontal arm
  const segB = [[1, 0, 2, 0], [2, 0, 2, 3], [2, 3, 1, 3], [1, 3, 1, 0]]; // vertical arm

  const resolved = resolvePlaneColors(
    [
      { key: 'A', color: 'magenta', segments: segA },
      { key: 'B', color: 'cyan', segments: segB },
    ],
    isBoundarySquare
  );
  assert(resolved.get('0,1') === 'magenta', 'synthetic tie: left arm magenta');
  assert(resolved.get('2,1') === 'magenta', 'synthetic tie: right arm magenta');
  assert(resolved.get('1,0') === 'cyan', 'synthetic tie: bottom arm cyan');
  assert(resolved.get('1,2') === 'cyan', 'synthetic tie: top arm cyan');
  assert(
    resolved.get('1,1') === 'magenta',
    'synthetic tie: center goes to the first-encountered face (A) on an exact area tie'
  );
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll faceColoring tests passed.');
