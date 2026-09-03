# Face-swapping drag (Gp mode)

Design notes from a discussion session. **Nothing here is implemented yet.**
This replaces the "open planes" drag described by `computeAvailablePlanes` in
`js/faceGeometry.js`. Picks up the `change face drag to plane swap + plane
sharing` todo.

## What changes

Today a drag offers a **filtered list of legal destination planes**: planes
where the dragged face's footprint doesn't interfere with the residents already
there, intersected with `dragBounds`. Illegal planes are simply not offered —
you slide past them, or you are `trapped` with nowhere to go.

Under face swapping, the dragged face **bubbles past** the faces in its way.
When it reaches a plane whose residents it would interfere with, those residents
swap back into the plane the dragged face is leaving. Most planes that were
previously refused become available.

## The step

A drag is a **sequence of discrete single-plane steps**, each applied to live
state. There is no continuous position and no non-integer configuration: the
dragged face's plane index is an integer that advances by steps.

For one step, moving face **F** from plane **P1** toward the next plane **P2**,
partition each plane's residents (excluding F) by whether they interfere with
F's in-plane footprint — the *same* footprint in both planes, since translating
along the normal doesn't change it:

|                   | interferes with F | doesn't      |
|-------------------|-------------------|--------------|
| **P1** (origin)   | *(empty)*         | **A** stay-behinds |
| **P2** (dest)     | **B** swappers    | **C** bystanders   |

**F and B trade planes. A and C never move.**

P1's "interferes" cell is empty by **invariant**: F occupies P1 legally, so
nothing there interferes with it. The swap re-establishes that invariant
(P2 afterwards holds C u {F}, and C is interference-free with F by definition),
which is what makes steps composable — after a step, relabel and the next step
is the same problem.

## Legality: two independent gates

### 1. Vertex impedance

The existing `dragBounds` notion — a dragged vertex passing a collinear
neighbour along its own drag-axis line. Prior to and independent of swapping.
This is a **hard wall**: it genuinely stops the drag.

Both directions of travel count. F's vertices move forward; **B's vertices move
backward**, and can be impeded too. This matters once planes are skipped (below),
because B then has to traverse an occupied plane.

### 2. Plane legality

Exactly one condition: **A must not interfere with B.**

Case analysis, one cell at a time:

- **A empty, C nonempty** — no condition. P1 afterwards holds B alone (its
  internal pairs unchanged, nothing else present). P2 holds C u {F}: C-vs-C
  unchanged, C-vs-F safe by C's definition. **C is entirely inert.** Its only
  significance is that after relabelling, this step's C becomes the next step's A.
- **A nonempty, C empty** — carries the condition. P2 holds F alone: fine.
  P1 holds A u B: A-vs-A unchanged, B-vs-B unchanged, but **A-vs-B is new** and
  unvetted. This is the only unchecked pairing anywhere in the step.
- **B empty** — collapses to nothing regardless of A. No new pairs.
- **A and C both nonempty** — adds nothing: C inert by the first case, A-vs-B
  live by the second.

The asymmetry has a structural cause worth remembering: **C is the set F joins**,
and C is *defined* by non-interference with F, so that pairing is safe by
construction. **A is the set B joins**, and A is defined by its relationship to
F, not to B — so it says nothing about how A and B relate. F is protected by
definition; A and B meet unvetted.

## Skipping

When A-vs-B blocks, the drag does **not** stop. That plane is removed from
consideration and the swap is retried against the next plane out. The blocked
plane keeps its contents and becomes an **inert layer** F passes over.

Geometric order becomes P1, P3, P2 — the swap is still between P1 and P2, they
are just no longer adjacent. "Adjacent" was never the operative property:
what the swap needs is that P1 and P2 be **consecutive among the planes F can
legally occupy**.

P3 is inert as an *occupancy* question (no faces enter or leave it; contributes
no pairs to check) but live as a *travel* question (both F's forward vertices
and B's backward vertices must clear it).

So a step is a **scan**, not a single test:

> From F's current plane, scan outward in the drag direction. For each candidate,
> compute **B fresh for that candidate** and test A-vs-B against the same A. The
> first candidate that passes is the destination; every plane scanned past
> becomes inert. Accumulate impedance checks across the whole span.

B is recomputed per candidate — the scan is not "find a legal plane" but "find a
plane whose *own* interferers can survive in P1". Termination: the model's
extent, or a vertex impedance wall.

**Bubbling removes most skips, not all.** F's own interference with residents —
the common case, the one today's rule trips on constantly — is dissolved by
swapping. What survives is the narrower A-vs-B case, plus impedance as a wall.

## UX

- **No available-plane rendering.** That notion is abandoned. F is part of the
  brink skeleton and moves as itself: vertex spheres and edge cylinders
  translate, incident edges stretch and shrink.
- **A continuous purple outline of F is required.** The skeleton can only move in
  whole-plane jumps, so on its own the gesture has NOTHING tracking the pointer
  between steps and reads as unresponsive. The outline is drawn at the raw drag
  value: it leads, and the skeleton snaps to it a step at a time.
  (Corrects an earlier claim here that the jump alone sufficed as feedback —
  it does not.)
- **Snaps into / snaps past.** A swap-ready plane is a resting index — the
  pointer can dwell and F stays. A skipped plane is an index F never occupies for
  any pointer position, so crossing the threshold moves F two planes at once.
  With the outline present a skip reads correctly: the outline glides across the
  skipped plane while the skeleton jumps over it.
  The outline must draw with `depthTest: false` — the dragged face is often
  inside the assembly, and the cube shell is frozen mid-drag so it never opens
  up. It also updates its interleaved position buffer IN PLACE rather than
  rebuilding the geometry, since it now redraws per pointermove, not per step.
- **Threshold, not snap zone.** A step fires when the pointer's axis projection
  crosses `STEP_THRESHOLD` of the way to the candidate. **Hysteresis is required**
  or F chatters at the boundary; forward and backward thresholds are computed
  independently, since with skips the forward and backward candidates may be
  different planes.
  Measured by sweeping pointer positions through the real threshold logic:
  **exactly 0.5 chatters** (forward and backward thresholds coincide, so F
  oscillates at the midpoint) and anything above it is stable. Settled on
  **0.6** — 0.55 also converges but leaves little margin for pointer jitter.
- **Reverse pops, it does not re-derive.** Keep a **stack of applied steps** and
  pop on reverse. See below.

## Why reverse cannot re-scan

After a forward step from P1 to P2 skipping P3, the state is: P1 = A u B,
P3 untouched, P2 = C u {F}. Scanning backward from there does **not** reliably
undo it:

- **The new A is C.** Backward, the stay-behinds are F's current planemates. So
  the backward legality test is C-vs-(candidate's interferers) — a different test
  from the forward A-vs-B. Nothing makes the answers agree.
- **P3 is a live candidate again.** It was skipped forward because of the *old*
  A. Backward it is tested against C. If that passes, F lands in P3 — a plane the
  forward drag deliberately passed over, and B stays stranded in P1.

That is the counterexample: **forward skips P3, backward accepts it.** It needs
C nonempty and P3's interferers to clear C having failed against A, so it may be
rare in practice — unmeasured.

(The swap partner itself is fine when the plane is right: P1 holds A u B, every
member of B interferes with F by definition so B comes back, and no member of A
does, so A stays. It is the *plane choice* that diverges, not the partner.)

The stack is preferred regardless of how rare the divergence is: it is less code
than a backward scan, it is exactly the commit payload, and abandoning the drag
is popping it — correctness by construction rather than by a symmetry argument
with a known hole.

## Performance

`updateBrinkSkeleton()` per step is out of the question at pointer-move rates —
that is the O(N^2) hazard in `CLAUDE.md`, firing on mouse moves instead of in a
loop.

A step moves only F and B, by one plane, along one axis. **Topology is unchanged
by construction** (this is the graph-preserving premise), so only the affected
vertex positions and edge geometry need updating.

**Decision (revised): cubes recompute with the skeleton, every step.** The
original plan was skeleton-live / cubes-on-commit, tried first as the simple
version. In the browser a frozen shell is **too confusing to read** — the shell
is the shape you are actually editing, and a stale one fights the drag. So
`redrawDragStep` refills the voxels and rebuilds the boundary faces alongside
the skeleton whenever a step fires.

This is affordable because the refill is per STEP, not per pointermove — steps
fire only on plane crossings. Measured cost of `fillCubesFromSkeleton` plus
`computeBoundaryCubeFaces`:

| Design | cubes | per step |
|---|---|---|
| kleinbottle | 12 | 0.5 ms |
| archimedean-quotient | 114 | 0.5 ms |
| great-rhombicosidodecahedron | 1096 | 1.5 ms |
| klein-quartic | 37257 | 58 ms |

Everything but the Klein quartic is free. The Klein quartic costs ~58 ms per
step (~54 of it `computeBoundaryCubeFaces` over 37k cubes), which is a brief
hitch on a deliberate plane crossing rather than a stuttering drag. If that ever
needs fixing, the boundary-face pass is the target, not the fill.

Consequences for the rest of the gesture, all of which follow from `positions`
now being live:
- `redrawDragStep` does NOT go through `adoptSkeleton`. History and localStorage
  belong to the commit, not to each intermediate state of a gesture in flight,
  and `currentSkeleton` stays untouched — the drag owns its drawing until commit.
- **commitDrag no longer refills.** `positions` is already correct, so the commit
  only adopts the drawing, records one history entry for the whole gesture, and
  persists.
- **cancelDrag must refill** from `baseSkeleton`, since the voxels were rewritten
  in place along with the skeleton.

Bulk voxel rules from `CLAUDE.md` apply throughout: raw primitives only, one
render at the end of each batch.

## Measured (implementation)

Swept every face of every design in `designs/`, both directions, up to 12 steps
each — 5,866 steps total. After every step, checked that *every* plane on *every*
axis is internally interference-free:

| Design | V | F | steps | with swappers | skips (max gap) | walls | illegal |
|---|---|---|---|---|---|---|---|
| archimedean-quotient-2 | 48 | 24 | 383 | 108 | 19 (4) | 30 | 0 |
| archimedean-quotient-3 | 48 | 24 | 440 | 100 | 9 (3) | 25 | 0 |
| archimedean-quotient | 48 | 24 | 314 | 120 | 22 (4) | 48 | 0 |
| dyck | 32 | 12 | 108 | 36 | 0 | 24 | 0 |
| great-rhombicosidodecahedron | 120 | 62 | 761 | 131 | 92 (3) | 101 | 0 |
| klein-quartic | 336 | 164 | 3656 | 528 | 84 (3) | 56 | 0 |
| kleinbottle | 24 | 14 | 108 | 34 | 2 (3) | 28 | 0 |
| non-orientable-2 | 20 | 11 | 96 | 30 | 0 | 22 | 0 |

**Zero illegal configurations, zero vertex fusions.** This answers the open
question the design left: **skips are real but uncommon — ~3.9% of steps**, with
a maximum gap of 4 planes. So bubbling does dissolve the great majority of
blocked planes, and "nearest plane is usually available" holds in practice.

**Round trip.** 326 drags pushed forward up to 6 steps then popped all the way
back: **all 326 restored the original drawing exactly**. This is the invariant a
backward re-scan could not have guaranteed (see above), and it validates the
step stack.

**Cube refill.** Every swapped drawing refills to cubes without error, and
re-deriving the graph from those cubes gives back identical V/E/F — the edits
really are graph-preserving.

**Cost.** On the Klein quartic (the largest, 336 vertices / 164 faces):
mean **0.14 ms per step**, worst **1.15 ms**; `buildSwapPlaneIndex` **0.06 ms**,
once per drag. Comfortably inside a pointer-move budget, which is what makes the
live skeleton affordable.
