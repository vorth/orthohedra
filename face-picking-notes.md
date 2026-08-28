# Face picking: findings and open questions

Notes from an exploration session, parked before implementation. Nothing here
is committed to code. Picks up the `unambiguous face drag control` todo.

## The problem

Picking a face for a drag works backwards today. A click lands on a **cube
square**; `connectedFace` (`main.js`, ~line 515) then scans *every* Graph face,
keeps those in the clicked plane, and picks whichever has the nearest edge to
the hit point. Face identity is reverse-engineered from geometry on every pick.

The idea was to make picking return face identity **by construction** instead.

## Key finding: a square can belong to two faces

A Graph face is a **cycle**. When a region has a hole, its outer and inner
boundaries are two disjoint cycles, and `computeBrinkSkeleton` reports them as
two separate faces — correctly, since the dimension-2 cycle walk has no way to
know they bound the same region. (The comment at `main.js` ~505-513 already
describes this case.)

Concretely, in `designs/kleinbottle.json`, the y=0 plane holds 11 boundary
squares in a ring around a one-cell hole:

```
v= 1  . . . .          face 0 (outer): (-1,-3)..(2,1)
v= 0  # # # .          face 1 (inner): (0,-1)..(1,0)
v=-1  # . # .          the hole at (0,-1) is correctly
v=-2  # # # .            NOT a boundary square
v=-3  # # # .
     -1 0 1 2
```

All 11 squares genuinely belong to **both** cycles. So "one face owns each
square" is false in general, and per-face geometry groups cannot be built.

**Today's behavior is arguably wrong here**: the nearest-edge tiebreak selects
the outer cycle when you click near the rim and the inner cycle when you click
near the hole — two different faces for the same region, decided by a pixel.

**The user should disambiguate, not the tiebreak.** This does *not* require
changing what a face is: no region concept, no "drawing face" concept. Store a
*list* of face keys per square and let the user choose when there is more than
one.

## Approaches measured and rejected

Recorded so they are not retried:

- **Point-in-polygon** on the cycle — claims the hole's square twice, and
  includes a square that is not a boundary square at all.
- **Scanline parity fill** — same failure. Separating outer from inner
  boundaries needs winding, which this codebase avoids by design (see the
  header comment in `brinkSkeleton.js`).
- **Adjacency fill over the actual boundary squares, blocked at cycle edges** —
  **this one works.** Its "11 squares owned by two faces" is not an error; it is
  the geometry.

## The approach that works

Per plane:

1. Take the boundary squares in that plane — **finite by construction**, so no
   fill can run away (this is what makes it safe versus filling an unbounded
   grid).
2. Build a **barrier set**: the unit segments making up every cycle edge in the
   plane.
3. For each face in the plane, seed from squares adjacent to its own edges and
   grow by in-plane edge adjacency, **never crossing a barrier**.

The barrier is what separates an outer ring from an inner hole without any
winding. Each square's owner list comes out as 1 key normally, 2+ where cycles
share a region.

## How rare the ambiguity is

Measured across the whole corpus:

| Design | squares | groups | faces | ambiguous groups | squares needing disambiguation |
|---|---|---|---|---|---|
| archimedean-quotient-2 | 698 | 24 | 24 | 0 | 0 |
| archimedean-quotient | 240 | 24 | 24 | 0 | 0 |
| dyck | 60 | 12 | 12 | 0 | 0 |
| great-rhombicosidodecahedron | 920 | 62 | 62 | 0 | 0 |
| klein-quartic | 50684 | 164 | 164 | 0 | 0 |
| kleinbottle | 60 | 13 | 14 | **1** | **11** |
| non-orientable-2 | 30 | 11 | 11 | 0 | 0 |

In the normal case the ownership partition **is** the face partition, exactly —
164 groups for 164 faces across the Klein quartic's 50,684 squares. Only
kleinbottle is ambiguous: one group of 11 squares shared by two faces.

So disambiguation is a rare path; the common path stays a single key.

## Decisions already made

- **No Three.js groups.** Keep the three per-axis InstancedMeshes and map
  instance → face keys instead. This preserves the per-axis tri-state visibility
  and the Klein quartic's rendering performance. The value of the exploration
  turned out to be the ownership *computation*, not the group mechanism.
  (`userData` on a group would have worked, but is unnecessary given this.)
- **`boundaryFaceInfoByAxis[axis][instanceId]` gains a `faceKeys` field**,
  computed once per render inside `renderBoundaryCubeFaces` (`main.js` ~211).
  A pick already yields `(axis, instanceId)`, so the lookup is direct.
- **The disambiguation interaction must not depend on hover** — touchscreen is a
  first-class target.

## Planned steps

1. **Compute ownership** with the boundary squares (adjacency fill above), and
   store `faceKeys` per instance. Rendering unchanged.
2. **Picking reads the keys** — `connectedFace` takes the face key from the
   picked square rather than scanning all faces. It still assembles the drag
   payload `{coord, key, vertexIndices, segments}`, but restructured as "given a
   key, produce the payload" rather than deriving it while scanning.
3. **Secondary in-plane selection** when a square has several owners.

Steps 1 and 2 are ready to build. **Step 3 is blocked on a UI decision** (see
below).

## Open question — blocks step 3

Step 2 needs *some* answer for a two-owner square. Silently taking `faceKeys[0]`
would be a **regression**: today's nearest-edge tiebreak at least varies with
where you click, so both cycles are reachable; taking the first key would make
the inner cycle unreachable entirely.

Recommended split: **ship steps 1+2 now, keeping nearest-edge as the tiebreak
among only the candidate faces.** No behavior regression, the expensive
all-faces scan still goes away, and step 3 becomes its own stage once the mode
work settles the interaction.

### Disambiguation options (all touch-viable)

Long-press is *not* a usable hover substitute: ~500ms latency floor, and it
collides with system gestures (text selection, context menus, iOS callouts,
Android accessibility). Apple HIG and Material both treat it as a secondary
action for infrequent operations.

1. **Tap-to-select, then act** — the dominant cross-platform pattern (Figma,
   Illustrator, Fusion 360, Shapr3D). First tap selects and shows candidates;
   a second picks one. Hover becomes a pure enhancement on pointer devices.
2. **Drag-direction disambiguation** — the initial drag direction picks the
   cycle: toward the rim selects outer, toward the hole inner. No extra tap, no
   hover, identical with mouse and finger, and a natural fit for annular
   geometry.
3. **Tap-to-cycle** — repeated taps walk the candidates. Undiscoverable in
   general, but viable here given one ambiguous group with two candidates.
4. **Disambiguation popup** — explicit and discoverable (Google Maps pins,
   AutoCAD coincident geometry); costs a UI surface.

Inclination: (1) as the base, (2) as a refinement. The app already uses pointer
events throughout, which unify mouse/touch/pen; `event.pointerType` can gate
hover affordances to devices that have them.

## Verification planned

Offline (numeric/topological, so within the CLAUDE.md self-testing exception):

1. **Ownership is total** — 0 orphan squares on all seven designs; group counts
   equal face counts on the six unambiguous designs; kleinbottle yields exactly
   1 ambiguous group of 11 squares.
2. **No phantom squares** — the owned set equals `computeBoundaryCubeFaces`
   exactly; the hole at `(0,-1)` is owned by nobody.
3. **Agreement with the old tiebreak** for clicks *near a face's own edges*,
   where the two should agree even in the annular case. (Note: comparing only
   single-owner squares proves little — that is exactly where the new code
   trivially agrees.)
4. **Drag unaffected** — the 756 `dragBounds`-legal moves still commit
   identically.

In-browser: drag faces on several designs; on kleinbottle, click the annular
region and confirm disambiguation rather than a silent guess; confirm per-axis
visibility cycling and Klein quartic rendering speed are unchanged.

## Related context

- Depends on the stable element identity from commit `a0a4563` (face keys are
  the canonicalized cycle of edge keys).
- The Gp face drag from commit `36226be` is what consumes the picked face key.
- Deferred neighbors: **plane sharing** (dropping onto an occupied plane, which
  needs an "interfere" definition), and **UI mode presentation** (Gp/Gb as
  "graph" and "cubes" modes, with cubes mode rendering in a visibly different
  style and different drag feedback per mode).
