// Everything that draws: the three.js scene, camera, controls and lights, the
// InstancedMeshes backing cubes / skeleton / drag visuals, and the functions
// that push model data into them.
//
// The dependency runs ONE WAY. This module is a SINK: it takes plain data
// (cube positions, a skeleton, in-plane segments) and puts pixels on screen. It
// never reads the voxel set, the history, or the drag state, and it calls
// nothing in main.js.
//
// It is a factory rather than loose exports because it owns a great deal of
// mutable GPU state — meshes, materials, instance capacities, the per-axis
// boundary-face index — that must not be module-level globals.
//
// Face visibility lives here too. It is a RENDERING choice, not model state:
// undo/redo deliberately excludes it, and persistence treats it as a view
// setting alongside the camera.

import * as THREE from "https://esm.sh/three@0.172.0";
import { TrackballControls } from "https://esm.sh/three@0.172.0/examples/jsm/controls/TrackballControls.js";
import { Line2 } from "https://esm.sh/three@0.172.0/examples/jsm/lines/Line2.js";
import { LineMaterial } from "https://esm.sh/three@0.172.0/examples/jsm/lines/LineMaterial.js";
import { LineSegmentsGeometry } from "https://esm.sh/three@0.172.0/examples/jsm/lines/LineSegmentsGeometry.js";
import { computeBoundaryCubeFaces } from "./brinkSkeleton.js";
import { inPlaneAxes } from "./faceGeometry.js";
import {
  MIN,
  MAX,
  AXIS_COLORS,
  FACE_COLORS,
  FACE_SOLID,
  FACE_TRANSLUCENT,
  FACE_HIDDEN,
} from "./constants.js";

// Initial per-mesh instance capacity; ensureInstanceCapacity() grows it (to the
// next power of two) whenever a render needs more. Deliberately small: the
// number of boundary faces and skeleton elements is bounded by the cubes
// actually placed (a surface-area quantity), never by the world volume.
const INITIAL_INSTANCES = 4096;

export function createSceneRenderer(app) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 300);
  camera.position.set(3.2, 2.3, 3.2);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  app.appendChild(renderer.domElement);

  const controls = new TrackballControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.minDistance = 1.8;
  controls.maxDistance = 120;
  controls.noPan = false;
  controls.rotateSpeed = 3.5;
  controls.zoomSpeed = 1.2;
  controls.panSpeed = 0.8;

  const hemiLight = new THREE.HemisphereLight(0xa8c7ff, 0x1f2a3f, 0.55);
  scene.add(hemiLight);

  // Three key lights attached to the camera (rather than the scene) so they
  // move with the viewer as the camera orbits, instead of staying fixed in
  // world space. Their directions are spaced 120 degrees apart around the
  // line of sight and tilted forward toward the viewer, so every face that
  // is visible at all catches at least one of them at a decent angle.
  // A DirectionalLight shines toward `target`, which defaults to the world
  // origin — parent each target to the camera too (at its local look-at
  // point) so the light directions stay camera-relative.
  const LIGHT_RING_RADIUS = 7;   // lateral offset in the camera's XY plane
  const LIGHT_RING_FORWARD = 5;  // how far toward the viewer (camera +Z)
  const LIGHT_PHASE = Math.PI / 2; // first light straight up, then 120 apart
  for (let i = 0; i < 3; i++) {
    const angle = LIGHT_PHASE + (i * 2 * Math.PI) / 3;
    const light = new THREE.DirectionalLight(0xfff4e8, 0.85);
    light.position.set(
      LIGHT_RING_RADIUS * Math.cos(angle),
      LIGHT_RING_RADIUS * Math.sin(angle),
      LIGHT_RING_FORWARD,
    );
    camera.add(light);
    camera.add(light.target);
    light.target.position.set(0, 0, -1);
  }

  scene.add(camera);

  // Cubes are identified by their least (min-x,y,z) corner, so a cube at
  // least corner c occupies [c, c+1]; with inBounds allowing MIN..MAX, the
  // occupied world volume is [MIN, MAX+1].
  const bounds = new THREE.Box3(
    new THREE.Vector3(MIN, MIN, MIN),
    new THREE.Vector3(MAX + 1, MAX + 1, MAX + 1)
  );

  // The giant boundary cube is drawn as just a wireframe outline (Box3Helper),
  // but backed by an invisible, still-clickable box of solid faces: clicking a
  // face cycles that axis's small-cube-face visibility (solid -> translucent ->
  // hidden). The mesh's `visible` stays true so the raycaster still hits it;
  // only the MATERIALS are non-rendering (material.visible = false), which
  // suppresses drawing without removing it from picking. Its BoxGeometry emits
  // 6 material groups in order +X,-X,+Y,-Y,+Z,-Z; we pair opposite faces onto
  // one material per axis so a ray hit's materialIndex maps straight to the
  // axis (materialIndex >> 1).
  const boundsHelper = new THREE.Box3Helper(bounds, 0x3e4f8c);
  scene.add(boundsHelper);

  const boundsCenter = new THREE.Vector3();
  bounds.getCenter(boundsCenter);
  const boundsSize = new THREE.Vector3();
  bounds.getSize(boundsSize);
  const boundsGeometry = new THREE.BoxGeometry(boundsSize.x, boundsSize.y, boundsSize.z);
  const boundsMaterials = [0, 1, 2].map(
    () => new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  );
  const boundsBox = new THREE.Mesh(
    boundsGeometry,
    [boundsMaterials[0], boundsMaterials[0], boundsMaterials[1], boundsMaterials[1], boundsMaterials[2], boundsMaterials[2]]
  );
  boundsBox.position.copy(boundsCenter);
  scene.add(boundsBox);

  // Boundary cube faces: one unit quad per non-internal cube face (every
  // face except those sandwiched between two present cubes) — replaces
  // rendering whole solid cubes. Faces are split into 3 meshes by their
  // normal axis (X/Y/Z) so each orientation's transparency can be
  // controlled independently: hiding one axis's skeleton edges (e.g. "no
  // red") should only make transparent the faces that LIE IN a plane
  // containing that axis (Y- and Z-normal faces, i.e. red-yellow and
  // red-blue planes) — the faces perpendicular to that axis (X-normal,
  // lying in the yellow-blue plane) stay solid.
  // Build a DynamicDraw InstancedMesh with the standard per-mesh settings.
  function makeInstancedMesh(geometry, material, capacity) {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    return mesh;
  }

  // Ensure `holder[index]` (an InstancedMesh in the scene) can hold at least
  // `needed` instances. InstancedMesh capacity is fixed at construction, so
  // "growing" means allocating a new mesh at the next power-of-two capacity,
  // swapping it into the scene in place of the old one, and disposing the old
  // one. The caller writes instances immediately afterward, so we don't copy the
  // stale matrix buffer across — only the mesh-level state that outlives a
  // re-render (visibility, renderOrder). Returns the current mesh (grown or not).
  function ensureInstanceCapacity(holder, index, needed) {
    const mesh = holder[index];
    if (needed <= mesh.instanceMatrix.count) return mesh;
    let capacity = mesh.instanceMatrix.count || INITIAL_INSTANCES;
    while (capacity < needed) capacity *= 2;
    const grown = makeInstancedMesh(mesh.geometry, mesh.material, capacity);
    grown.visible = mesh.visible;
    grown.renderOrder = mesh.renderOrder;
    scene.remove(mesh);
    mesh.dispose();
    scene.add(grown);
    holder[index] = grown;
    return grown;
  }

  // A flat square OUTLINE (border only, no fill) as real triangulated
  // geometry: four thin rectangular strips around the perimeter, meeting at
  // mitered corners, with nothing spanning the open middle. Unlike a
  // wireframe-rendered PlaneGeometry — which draws the diagonal shared by its
  // two triangles along with the real edges — this has no diagonal to draw,
  // because there IS no cross-square triangle. Centered on the origin in the
  // XY plane, facing +Z, so it composes with the same per-axis quaternions
  // used for the solid cube faces.
  function makeSquareOutlineGeometry(size, thickness) {
    const o = size / 2; // outer half-extent
    const i = o - thickness; // inner half-extent
    // 8 corners: outer ring then inner ring, each starting top-right, going
    // counter-clockwise (+X,+Y) -> (-X,+Y) -> (-X,-Y) -> (+X,-Y).
    const positions = new Float32Array([
      o, o, 0, -o, o, 0, -o, -o, 0, o, -o, 0, // outer 0-3
      i, i, 0, -i, i, 0, -i, -i, 0, i, -i, 0, // inner 4-7
    ]);
    // Two triangles per side of the frame, winding consistent with the outer
    // ring's CCW order so the border reads as one continuous strip.
    const index = [];
    for (let k = 0; k < 4; k++) {
      const oA = k, oB = (k + 1) % 4, iA = 4 + k, iB = 4 + ((k + 1) % 4);
      index.push(oA, oB, iB, oA, iB, iA);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(index);
    return geometry;
  }

  const faceGeometry = new THREE.PlaneGeometry(1, 1);
  // Each axis's faces are tinted with that axis's FACE_COLORS shade (X red,
  // Y yellow, Z blue, lightened slightly toward white).
  const cubeFaceMaterials = [0, 1, 2].map(
    (axis) =>
      new THREE.MeshStandardMaterial({
        color: FACE_COLORS[axis],
        roughness: 0.64,
        metalness: 0.05,
        transparent: true,
        opacity: 1,
        side: THREE.DoubleSide,
      })
  );
  const cubeFaceMeshes = cubeFaceMaterials.map((material) => {
    const mesh = makeInstancedMesh(faceGeometry, material, INITIAL_INSTANCES);
    scene.add(mesh);
    return mesh;
  });

  // Black square outlines on each boundary face, for Cubes mode (which shows
  // no skeleton edges — see setSkeletonVisible/setCubeEdgesVisible). Built
  // from the diagonal-free frame geometry above, so — unlike a
  // wireframe-rendered plane — no diagonal is drawn. Not pickable (never
  // passed to getIntersection).
  //
  // The frame sits exactly coplanar with the solid face it outlines (same
  // per-instance transform, no normal offset — the geometry is instanced
  // across all three axes' quaternions, so there's no single "outward"
  // direction to bake into a per-vertex nudge). Coplanar geometry z-fights:
  // the GPU's depth test can't consistently decide which layer wins, so
  // pixels along the border flicker between the two — the "sketchy" look.
  // `polygonOffset` fixes this at the rasterizer level (nudges the DEPTH
  // VALUE used for the test, not the vertex position), which is the standard
  // fix for exactly this decal-over-surface case and works at any viewing
  // angle/distance, unlike a fixed geometric offset.
  const cubeEdgeGeometry = makeSquareOutlineGeometry(1, 0.03);
  const cubeEdgeMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const cubeEdgeMeshes = [0, 1, 2].map(() => {
    const mesh = makeInstancedMesh(cubeEdgeGeometry, cubeEdgeMaterial, INITIAL_INSTANCES);
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  });

  // Per-instance metadata for the current boundary faces, one array per axis
  // mesh, indexed the same as that mesh's instances — kept for full rebuilds
  // (renderBoundaryCubeFaces) and picking (boundaryFaceInfo).
  let boundaryFaceInfoByAxis = [[], [], []];

  // Per-axis-mesh slot bookkeeping for INCREMENTAL boundary-face updates (see
  // addBoundaryFace/removeBoundaryFace below), used by a cubes-mode drag step
  // instead of a full renderBoundaryCubeFaces rescan. Swap-pop, exactly like
  // main.js's `positions`/`occupied`: `faceSlotByAxis[axis]` maps a face's key
  // ("x,y,z,sign") to its instance index in that axis's mesh, so both a
  // single add and a single remove are O(1) instead of O(all boundary faces).
  const faceKey = (x, y, z, sign) => `${x},${y},${z},${sign}`;
  const faceSlotByAxis = [new Map(), new Map(), new Map()];

  const faceTempMatrix = new THREE.Matrix4();
  // Reused across all face instances so a large model (tens of thousands of
  // boundary faces) doesn't allocate two Vector3s per instance each render.
  const faceTempPosition = new THREE.Vector3();
  const faceTempScale = new THREE.Vector3(1, 1, 1);
  const faceQuaternions = [
    [ // axis 0 (X): rotate the plane (default facing +Z) to face +X / -X
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2),
    ],
    [ // axis 1 (Y): rotate to face +Y / -Y
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
    ],
    [ // axis 2 (Z): rotate to face +Z / -Z (identity / 180°)
      new THREE.Quaternion(),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI),
    ],
  ];

  function renderBoundaryCubeFaces(cubePositions) {
    const boundaryFaces = computeBoundaryCubeFaces(cubePositions);
    const byAxis = [[], [], []];
    for (const face of boundaryFaces) byAxis[face.axis].push(face);
    boundaryFaceInfoByAxis = byAxis;

    for (let axis = 0; axis < 3; axis++) {
      const axisFaces = byAxis[axis];
      const mesh = ensureInstanceCapacity(cubeFaceMeshes, axis, axisFaces.length);
      mesh.count = axisFaces.length;
      const edgeMesh = ensureInstanceCapacity(cubeEdgeMeshes, axis, axisFaces.length);
      edgeMesh.count = axisFaces.length;
      const slots = new Map();
      faceSlotByAxis[axis] = slots;
      for (let i = 0; i < axisFaces.length; i++) {
        const { x, y, z, sign, center } = axisFaces[i];
        const signIdx = sign === 1 ? 0 : 1;
        faceTempPosition.set(center[0], center[1], center[2]);
        faceTempMatrix.compose(faceTempPosition, faceQuaternions[axis][signIdx], faceTempScale);
        mesh.setMatrixAt(i, faceTempMatrix);
        edgeMesh.setMatrixAt(i, faceTempMatrix);
        slots.set(faceKey(x, y, z, sign), i);
      }
      mesh.instanceMatrix.needsUpdate = true;
      edgeMesh.instanceMatrix.needsUpdate = true;
      // InstancedMesh caches a bounding sphere for raycasting that isn't
      // automatically invalidated when instances move or `count`
      // changes — recompute it here or hover/click detection can
      // intermittently miss instances outside the stale bounds. Only the
      // solid face mesh is ever raycast (edges are never picked).
      mesh.computeBoundingSphere();
    }
    // A full rebuild already resyncs everything the incremental path below
    // would otherwise need to catch up on.
    dirtyBoundaryAxes.clear();
  }

  // --- Incremental boundary-face updates ------------------------------------
  // A cubes-mode drag toggles ONE cube per step; recomputing the whole
  // boundary (renderBoundaryCubeFaces, O(every cube in the model)) on every
  // step visibly lags on large models. These add/remove one instance at a
  // time — O(1) — using the same swap-pop trick as main.js's `positions`.
  //
  // None of these recompute the meshes' bounding spheres (computeBoundingSphere
  // is itself O(current instance count), so doing it on every one of a drag's
  // many single-face updates would reintroduce the same O(N)-per-step cost).
  // Picking is never raycast mid-drag, only before the next one starts, so a
  // stale bounding sphere is harmless until then — call
  // finalizeBoundaryFaces() once after a batch of these (see
  // commitCubesDrag) to bring it back in sync before picking needs it again.
  const dirtyBoundaryAxes = new Set();

  // Appends one face instance to the end of its axis mesh (and its edge-outline
  // counterpart, kept at the same slot index).
  function addBoundaryFace(x, y, z, axis, sign, center) {
    const mesh = ensureInstanceCapacity(cubeFaceMeshes, axis, boundaryFaceInfoByAxis[axis].length + 1);
    const edgeMesh = ensureInstanceCapacity(cubeEdgeMeshes, axis, boundaryFaceInfoByAxis[axis].length + 1);
    const i = boundaryFaceInfoByAxis[axis].length;
    mesh.count = i + 1;
    edgeMesh.count = i + 1;
    const signIdx = sign === 1 ? 0 : 1;
    faceTempPosition.set(center[0], center[1], center[2]);
    faceTempMatrix.compose(faceTempPosition, faceQuaternions[axis][signIdx], faceTempScale);
    mesh.setMatrixAt(i, faceTempMatrix);
    edgeMesh.setMatrixAt(i, faceTempMatrix);
    mesh.instanceMatrix.needsUpdate = true;
    edgeMesh.instanceMatrix.needsUpdate = true;
    boundaryFaceInfoByAxis[axis].push({ x, y, z, axis, sign, center });
    faceSlotByAxis[axis].set(faceKey(x, y, z, sign), i);
    dirtyBoundaryAxes.add(axis);
  }

  // Removes one face instance, swapping the last instance into its slot (both
  // the matrix buffer and the parallel info/slot bookkeeping) so the mesh
  // stays a dense [0, count) range. The edge-outline mesh mirrors the same
  // swap so its slots stay aligned with the face mesh's.
  function removeBoundaryFace(x, y, z, axis, sign) {
    const key = faceKey(x, y, z, sign);
    const slots = faceSlotByAxis[axis];
    const i = slots.get(key);
    if (i === undefined) return; // not currently a boundary face: nothing to do
    const infos = boundaryFaceInfoByAxis[axis];
    const mesh = cubeFaceMeshes[axis];
    const edgeMesh = cubeEdgeMeshes[axis];
    const lastIdx = infos.length - 1;
    if (i !== lastIdx) {
      mesh.getMatrixAt(lastIdx, faceTempMatrix);
      mesh.setMatrixAt(i, faceTempMatrix);
      edgeMesh.setMatrixAt(i, faceTempMatrix);
      const moved = infos[lastIdx];
      infos[i] = moved;
      slots.set(faceKey(moved.x, moved.y, moved.z, moved.sign), i);
    }
    infos.pop();
    slots.delete(key);
    mesh.count = infos.length;
    edgeMesh.count = infos.length;
    mesh.instanceMatrix.needsUpdate = true;
    edgeMesh.instanceMatrix.needsUpdate = true;
    dirtyBoundaryAxes.add(axis);
  }

  // Bring picking's bounding spheres back in sync after a batch of
  // add/removeBoundaryFace calls (see the note above). Cheap to call when
  // nothing changed (visits only the axes actually touched).
  function finalizeBoundaryFaces() {
    for (const axis of dirtyBoundaryAxes) cubeFaceMeshes[axis].computeBoundingSphere();
    dirtyBoundaryAxes.clear();
  }

  // Add or remove the up-to-6 boundary faces touched by toggling ONE cube at
  // (x,y,z): its own faces (all appear on add, all disappear on remove), plus
  // — for each direction where a neighbor cube already exists — that
  // neighbor's face pointing back at this cube (which flips the other way:
  // disappears when this cube appears and stops being a gap, reappears when
  // this cube is removed and exposes it again). `hasCube(x,y,z)` must reflect
  // the model AFTER the toggle (i.e. call this after updating `positions`).
  function toggleCubeFaces(x, y, z, adding, hasCube) {
    for (const axis of [0, 1, 2]) {
      for (const sign of [-1, 1]) {
        const n = [x, y, z];
        n[axis] += sign;
        const neighborPresent = hasCube(n[0], n[1], n[2]);
        if (adding) {
          if (neighborPresent) {
            // This cube fills a gap the neighbor's face was covering.
            removeBoundaryFace(n[0], n[1], n[2], axis, -sign);
          } else {
            const center = [x + 0.5, y + 0.5, z + 0.5];
            center[axis] += sign / 2;
            addBoundaryFace(x, y, z, axis, sign, center);
          }
        } else {
          removeBoundaryFace(x, y, z, axis, sign);
          if (neighborPresent) {
            const center = [n[0] + 0.5, n[1] + 0.5, n[2] + 0.5];
            center[axis] += -sign / 2;
            addBoundaryFace(n[0], n[1], n[2], axis, -sign, center);
          }
        }
      }
    }
  }

  // The diagonal-free frame geometry (not a wireframe-rendered PlaneGeometry,
  // which would draw the diagonal shared by its two triangles along with the
  // real edges).
  const hoverOutline = new THREE.Mesh(
    makeSquareOutlineGeometry(1.02, 0.03),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })
  );
  hoverOutline.visible = false;
  scene.add(hoverOutline);

  // --- Move mode visuals ---------------------------------------------------
  // The swapping drag renders the dragged face's SETTLED position as itself:
  // its vertices and edges are real skeleton geometry, rewritten in place each
  // time a step fires. On top of that sits the purple outline of the grabbed
  // cycle, drawn at the RAW drag value rather than at an integer plane.
  //
  // The outline is what makes the gesture feel continuous. Steps are discrete,
  // so the skeleton can only ever jump from one plane to the next; the outline
  // moves smoothly with the pointer and the skeleton snaps to it. It also shows
  // a skip for what it is — the outline glides across the skipped plane while
  // the skeleton jumps over it.
  //
  // Outlines use three's fat-line classes (Line2 + LineMaterial) for genuine
  // screen-space thickness — LineBasicMaterial.linewidth is clamped to 1px by
  // WebGL. `linewidth` is in world/pixel units per LineMaterial; resolution
  // must track the canvas size (kept current on resize below).
  const GRABBED_COLOR = 0xd8b8ff;
  const OUTLINE_LINEWIDTH = 6;

  // The grabbed face is drawn from its brink-skeleton EDGES: `segments` are its
  // in-plane [au,av,bu,bv] endpoints (on the two non-edit axes), lifted into
  // world space at the given edit-axis value. `out` is filled in place — this
  // runs on every pointermove, so it must not allocate.
  const _segP = [0, 0, 0];
  function writeEdgePositions(axis, segments, value, out) {
    const [ua, ub] = inPlaneAxes(axis);
    _segP[axis] = value;
    let i = 0;
    for (const [au, av, bu, bv] of segments) {
      _segP[ua] = au;
      _segP[ub] = av;
      out[i++] = _segP[0];
      out[i++] = _segP[1];
      out[i++] = _segP[2];
      _segP[ua] = bu;
      _segP[ub] = bv;
      out[i++] = _segP[0];
      out[i++] = _segP[1];
      out[i++] = _segP[2];
    }
    return out;
  }

  const grabbedMaterial = new LineMaterial({
    color: GRABBED_COLOR,
    linewidth: OUTLINE_LINEWIDTH,
    // The dragged face is frequently inside the assembly — and the cube shell
    // is frozen mid-drag, so it does not open up as the face leaves. Draw the
    // outline through everything, or the feedback vanishes exactly when the
    // drag needs it.
    depthTest: false,
  });
  grabbedMaterial.transparent = true;
  function updateOutlineResolution() {
    grabbedMaterial.resolution.set(window.innerWidth, window.innerHeight);
  }
  updateOutlineResolution();

  const grabbedOutline = new Line2(new LineSegmentsGeometry(), grabbedMaterial);
  grabbedOutline.frustumCulled = false;
  grabbedOutline.renderOrder = 5;
  grabbedOutline.visible = false;
  scene.add(grabbedOutline);

  // Scratch position array for the outline, sized to the grabbed cycle when the
  // drag starts and reused for every subsequent move.
  let grabbedPositions = null;

  // Begin tracking a grabbed cycle. Allocates the geometry ONCE per drag;
  // moveGrabbedFace then only rewrites its position attribute.
  function showGrabbedFace(axis, segments, value) {
    grabbedPositions = new Float32Array(segments.length * 6);
    writeEdgePositions(axis, segments, value, grabbedPositions);
    grabbedOutline.geometry.dispose();
    const geo = new LineSegmentsGeometry();
    geo.setPositions(grabbedPositions);
    grabbedOutline.geometry = geo;
    grabbedOutline.visible = true;
  }

  // Slide the outline to `value` — called on every pointermove, so it updates
  // the existing buffers in place rather than rebuilding the geometry.
  // LineSegmentsGeometry stores each segment as instanced start/end attributes,
  // so both are refreshed from the same flat array.
  function moveGrabbedFace(axis, segments, value) {
    if (!grabbedPositions) return;
    writeEdgePositions(axis, segments, value, grabbedPositions);
    const geo = grabbedOutline.geometry;
    const start = geo.getAttribute('instanceStart');
    const end = geo.getAttribute('instanceEnd');
    if (!start || !end) return;
    // instanceStart and instanceEnd are interleaved views on ONE buffer, so
    // writing through either updates both; upload it once.
    start.data.set(grabbedPositions);
    start.data.needsUpdate = true;
    // Both bounds are derived from the same buffer and go stale when it moves.
    // `frustumCulled` is off for this outline, but LineSegmentsGeometry's own
    // bounds are cheap and keeping them honest avoids a surprise if anything
    // later raycasts against it.
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
  }

  function hideGrabbedFace() {
    grabbedOutline.visible = false;
  }

  // Brink skeleton rendering: white spheres at vertices, and
  // cylinders for edges colored red/yellow/blue by their X/Y/Z axis.
  const SKELETON_VERTEX_RADIUS = (0.125 / 2) * 1.6; // diameter 1/8 of a cube edge, scaled 60% larger
  const SKELETON_EDGE_RADIUS = SKELETON_VERTEX_RADIUS * 0.4; // halved back down from the previous 2x

  const skeletonVertexGeometry = new THREE.SphereGeometry(SKELETON_VERTEX_RADIUS, 12, 8);
  const skeletonVertexMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
  // Single-element holder so ensureInstanceCapacity can swap the grown mesh in.
  const skeletonVertexHolder = [makeInstancedMesh(skeletonVertexGeometry, skeletonVertexMaterial, INITIAL_INSTANCES)];
  scene.add(skeletonVertexHolder[0]);

  // Impeding-vertex highlight: during a move-mode drag, the barrier vertices
  // that block the drag (the collinear neighbors a dragged vertex must not
  // pass) are marked with a slightly larger red-emissive sphere, drawn over
  // the white vertex spheres. `count` is set per drag from dragBounds().
  const IMPEDER_MAX = 64; // more than any face's vertex count * 2 barriers
  const impederGeometry = new THREE.SphereGeometry(SKELETON_VERTEX_RADIUS * 1.35, 12, 8);
  const impederMaterial = new THREE.MeshStandardMaterial({
    color: 0xff2020,
    emissive: 0xff0000,
    emissiveIntensity: 0.9,
    roughness: 0.5,
  });
  const impederMesh = makeInstancedMesh(impederGeometry, impederMaterial, IMPEDER_MAX);
  impederMesh.renderOrder = 4;
  impederMesh.count = 0;
  scene.add(impederMesh);

  const _impederMatrix = new THREE.Matrix4();
  function showImpeders(points) {
    const n = Math.min(points.length, IMPEDER_MAX);
    for (let i = 0; i < n; i++) {
      const [x, y, z] = points[i];
      _impederMatrix.makeTranslation(x, y, z);
      impederMesh.setMatrixAt(i, _impederMatrix);
    }
    impederMesh.count = n;
    impederMesh.instanceMatrix.needsUpdate = true;
  }

  function hideImpeders() {
    impederMesh.count = 0;
  }

  // Unit-height cylinder along Y; scaled/rotated/positioned per edge.
  const skeletonEdgeGeometry = new THREE.CylinderGeometry(SKELETON_EDGE_RADIUS, SKELETON_EDGE_RADIUS, 1, 8);
  // Skeleton edges are always rendered (their visibility is no longer tied to
  // face visibility) — colored by axis with the full-strength AXIS_COLORS.
  const skeletonEdgeMeshes = AXIS_COLORS.map((color) => {
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
    const mesh = makeInstancedMesh(skeletonEdgeGeometry, material, INITIAL_INSTANCES);
    scene.add(mesh);
    return mesh;
  });

  // Per-axis face visibility, a tri-state cycled by clicking the giant boundary
  // cube's faces: SOLID -> TRANSLUCENT -> HIDDEN -> SOLID. Each axis (X/Y/Z)
  // is controlled independently. `faceVisibility[axis]` holds the current state.
  const faceVisibility = [FACE_SOLID, FACE_SOLID, FACE_SOLID];

  // Apply `faceVisibility` to the small boundary-cube face meshes. A translucent
  // material that still writes depth marks its pixels as occupied at its own
  // (nearer) depth, so solid geometry drawn later at a greater depth fails the
  // depth test and vanishes instead of showing through; disable depth writes
  // while translucent and render those meshes after (renderOrder 1) the opaque
  // ones (renderOrder 0) so depth/color are established before they blend on top.
  function applyFaceVisibility() {
    for (let axis = 0; axis < 3; axis++) {
      const state = faceVisibility[axis];
      const mesh = cubeFaceMeshes[axis];
      const material = cubeFaceMaterials[axis];
      mesh.visible = state !== FACE_HIDDEN;
      const translucent = state === FACE_TRANSLUCENT;
      material.opacity = translucent ? 0.3 : 1;
      material.depthWrite = !translucent;
      mesh.renderOrder = translucent ? 1 : 0;
    }
  }

  // Advance one axis's face visibility to the next state in the cycle.
  function cycleFaceVisibility(axis) {
    faceVisibility[axis] = (faceVisibility[axis] + 2) % 3; // 2->1->0->2
    applyFaceVisibility();
  }

  const skeletonTempMatrix = new THREE.Matrix4();
  const skeletonTempPosition = new THREE.Vector3();
  const skeletonTempScale = new THREE.Vector3(1, 1, 1);
  const skeletonEdgeQuaternions = [
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2), // Y-cylinder -> X
    new THREE.Quaternion(), // Y-cylinder -> Y (identity)
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2), // Y-cylinder -> Z
  ];

  function renderBrinkSkeleton(skeleton) {
    const skeletonVertexMesh = ensureInstanceCapacity(skeletonVertexHolder, 0, skeleton.vertices.length);
    skeletonVertexMesh.count = skeleton.vertices.length;
    for (let i = 0; i < skeleton.vertices.length; i++) {
      const [x, y, z] = skeleton.vertices[i];
      skeletonTempMatrix.makeTranslation(x, y, z);
      skeletonVertexMesh.setMatrixAt(i, skeletonTempMatrix);
    }
    skeletonVertexMesh.instanceMatrix.needsUpdate = true;

    const edgesByAxis = [[], [], []];
    for (const [vi, vj] of skeleton.edges) {
      const a = skeleton.vertices[vi];
      const b = skeleton.vertices[vj];
      const axis = a[0] !== b[0] ? 0 : a[1] !== b[1] ? 1 : 2;
      edgesByAxis[axis].push([a, b]);
    }

    for (let axis = 0; axis < 3; axis++) {
      const axisEdges = edgesByAxis[axis];
      const mesh = ensureInstanceCapacity(skeletonEdgeMeshes, axis, axisEdges.length);
      mesh.count = axisEdges.length;
      for (let i = 0; i < axisEdges.length; i++) {
        const [a, b] = axisEdges[i];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        const midX = (a[0] + b[0]) / 2;
        const midY = (a[1] + b[1]) / 2;
        const midZ = (a[2] + b[2]) / 2;
        skeletonTempPosition.set(midX, midY, midZ);
        skeletonTempScale.set(1, length, 1);
        skeletonTempMatrix.compose(skeletonTempPosition, skeletonEdgeQuaternions[axis], skeletonTempScale);
        mesh.setMatrixAt(i, skeletonTempMatrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // Show/hide the skeleton meshes (vertices + edges) wholesale, e.g. for Cubes
  // mode, which shows only cube faces. `ensureInstanceCapacity` carries
  // `.visible` across a grown replacement mesh, so this holds even if the
  // skeleton grows while hidden.
  function setSkeletonVisible(visible) {
    skeletonVertexHolder[0].visible = visible;
    for (const mesh of skeletonEdgeMeshes) mesh.visible = visible;
  }

  // Show/hide the black square outlines on each boundary cube face — the
  // Cubes-mode counterpart to setSkeletonVisible's Graph-mode edges.
  function setCubeEdgesVisible(visible) {
    for (const mesh of cubeEdgeMeshes) mesh.visible = visible;
  }

  // --- Picking -------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  // Client (CSS pixel) coordinates -> normalized device coordinates.
  function ndc(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    return pointer;
  }

  // Raycast into the given meshes (the cube faces by default) at a client
  // point. Returns three's intersection list, nearest first.
  function getIntersection(clientX, clientY, meshes = cubeFaceMeshes) {
    raycaster.setFromCamera(ndc(clientX, clientY), camera);
    // intersectObjects raycasts every mesh passed directly in the array
    // regardless of its `.visible` flag (visibility is only honored when
    // descending into CHILDREN during recursive traversal). Filter to visible
    // meshes ourselves so hidden faces aren't pickable — letting clicks and
    // hover pass through to interior orthogonal faces behind them.
    return raycaster.intersectObjects(meshes.filter((m) => m.visible), false);
  }

  // The ray for a client point, for callers doing their own geometry against
  // it (the drag projects it onto an axis-parallel line).
  function rayFrom(clientX, clientY) {
    raycaster.setFromCamera(ndc(clientX, clientY), camera);
    return raycaster.ray;
  }

  // Which axis' face mesh is this? -1 if the hit object isn't one of them.
  const faceMeshAxis = (object) => cubeFaceMeshes.indexOf(object);

  // --- Cubes-mode drag geometry ---------------------------------------------
  // How far the pointer must travel, in pixels, before the cubes-mode drag
  // (see main.js) toggles the next cube. Expressed in cube-widths rather than
  // a fixed pixel count so the gesture tracks the model, not the screen: drag
  // across two cubes' worth of on-screen space and you get two cubes, whether
  // the camera is close in or zoomed out. Floored so extreme zoom-out (a cube
  // covering a pixel or two) can't turn a small twitch into a dozen cubes.
  const DRAG_PER_CUBE = 0.75;
  const MIN_DRAG_PIXELS = 8;

  function dragStepPixels() {
    const rect = renderer.domElement.getBoundingClientRect();
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const distance = camera.position.distanceTo(controls.target);
    const visibleWorldHeight = 2 * distance * Math.tan(fov / 2);
    const pixelsPerCube = rect.height / visibleWorldHeight; // cubes are unit size
    return Math.max(MIN_DRAG_PIXELS, pixelsPerCube * DRAG_PER_CUBE);
  }

  // A world-space point's outward face-normal direction, projected to a 2-D
  // screen-space vector — lets a cubes-mode drag tell "out of the face" from
  // "into it" by comparing against the pointer's on-screen movement. `point`
  // need not be a lattice point; the caller passes the actual face center.
  const _screenDirBase = new THREE.Vector3();
  const _screenDirTip = new THREE.Vector3();
  function screenDirection(point, dir) {
    _screenDirBase.set(point[0], point[1], point[2]).project(camera);
    _screenDirTip.set(point[0] + dir[0], point[1] + dir[1], point[2] + dir[2]).project(camera);
    const dx = _screenDirTip.x - _screenDirBase.x;
    // Screen y grows downward (NDC y grows upward), hence the negation.
    const dy = -(_screenDirTip.y - _screenDirBase.y);
    const len = Math.hypot(dx, dy);
    return len < 1e-9 ? { x: 0, y: -1 } : { x: dx / len, y: dy / len };
  }

  // --- Hover outline -------------------------------------------------------
  // Snap the hover outline onto one instanced quad, nudged very slightly along
  // its own normal so it doesn't z-fight the face it outlines.
  function showHoverOutline(mesh, instanceId) {
    mesh.getMatrixAt(instanceId, hoverOutline.matrix);
    hoverOutline.matrix.decompose(hoverOutline.position, hoverOutline.quaternion, hoverOutline.scale);
    hoverOutline.translateZ(0.002);
    hoverOutline.visible = true;
  }

  const hideHoverOutline = () => {
    hoverOutline.visible = false;
  };

  // --- Camera / viewport ---------------------------------------------------
  // `up` is part of the camera state, not a constant. TrackballControls is a
  // true trackball: _rotateCamera applies its rotation to camera.up as well as
  // to the eye vector, so up is re-derived continuously and is the real
  // screen-up direction. _panCamera builds both of its pan axes from it
  // (eye x up for horizontal, up itself for vertical), which is only correct
  // while up stays perpendicular to the eye vector. Restoring position/target
  // without up leaves up at the default (0,1,0), inconsistent with the restored
  // orientation — panning then skews and partly dollies instead of moving in
  // the viewport plane.
  const getCameraState = () => ({
    position: camera.position.toArray(),
    target: controls.target.toArray(),
    up: camera.up.toArray(),
  });

  function setCameraState({ position, target, up }) {
    camera.position.fromArray(position);
    controls.target.fromArray(target);
    // Older saved states predate `up`; re-derive a perpendicular one so the
    // trackball invariant holds either way.
    if (up) {
      camera.up.fromArray(up);
    } else {
      const eye = camera.position.clone().sub(controls.target);
      const side = new THREE.Vector3().crossVectors(camera.up, eye);
      // Degenerate only if the stored up is parallel to the eye vector; any
      // perpendicular will do there, so fall back to a world axis.
      if (side.lengthSq() < 1e-12) side.crossVectors(new THREE.Vector3(1, 0, 0), eye);
      if (side.lengthSq() < 1e-12) side.crossVectors(new THREE.Vector3(0, 0, 1), eye);
      camera.up.crossVectors(eye, side).normalize();
    }
    controls.update();
  }

  // Pan/zoom so the model's bounding sphere fills about half the viewport
  // (its diameter spans half the shorter screen dimension), keeping the
  // current viewing direction and up — only WHERE the camera looks from
  // changes, not which way it's oriented. For a "Center View" menu item.
  //
  // `positions` are cube least-corners (unit cubes), so the model's world
  // bounds run from the min corner to the max corner + 1 on each axis.
  function centerView(positions) {
    if (!positions.length) return;
    const box = new THREE.Box3();
    const corner = new THREE.Vector3();
    for (const { x, y, z } of positions) {
      corner.set(x, y, z);
      box.expandByPoint(corner);
      corner.set(x + 1, y + 1, z + 1);
      box.expandByPoint(corner);
    }
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;

    // Distance at which the bounding sphere's diameter fills half the
    // vertical frustum: half-height at distance d is d*tan(fov/2), so a
    // sphere of radius r fills half of that when d = r / (0.5*tan(fov/2)).
    // The horizontal frustum is narrower than the vertical one whenever the
    // viewport is portrait-oriented (aspect < 1), so account for aspect too.
    const verticalHalfAngle = THREE.MathUtils.degToRad(camera.fov / 2);
    const limitingHalfAngle = camera.aspect >= 1
      ? verticalHalfAngle
      : Math.atan(Math.tan(verticalHalfAngle) * camera.aspect);
    const distance = radius / (0.5 * Math.tan(limitingHalfAngle));

    // Keep the current viewing direction: move along the (target -> eye) ray,
    // re-centered on the model, to the distance computed above.
    const direction = camera.position.clone().sub(controls.target).normalize();
    const position = center.clone().addScaledVector(direction, distance);
    setCameraState({ position: position.toArray(), target: center.toArray(), up: camera.up.toArray() });
  }

  function handleResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    updateOutlineResolution();
    controls.handleResize();
  }

  // Suspend the trackball (so a face drag doesn't also rotate the camera).
  const setControlsEnabled = (on) => {
    controls.enabled = on;
  };

  function start() {
    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });
  }

  return {
    // event target for pointer handlers
    domElement: renderer.domElement,
    // model -> pixels
    renderBoundaryCubeFaces,
    renderBrinkSkeleton,
    setSkeletonVisible,
    setCubeEdgesVisible,
    toggleCubeFaces,
    finalizeBoundaryFaces,
    // face visibility (a rendering choice, owned here)
    faceVisibility,
    applyFaceVisibility,
    cycleFaceVisibility,
    // drag visuals
    showGrabbedFace,
    moveGrabbedFace,
    hideGrabbedFace,
    showImpeders,
    hideImpeders,
    // hover
    showHoverOutline,
    hideHoverOutline,
    // picking
    getIntersection,
    rayFrom,
    faceMeshAxis,
    boundsBox,
    boundaryFaceInfo: (axis) => boundaryFaceInfoByAxis[axis],
    // cubes-mode drag geometry
    dragStepPixels,
    screenDirection,
    // camera / viewport / loop
    getCameraState,
    setCameraState,
    centerView,
    setControlsEnabled,
    handleResize,
    start,
  };
}
