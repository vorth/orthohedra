import * as THREE from "https://esm.sh/three@0.172.0";
import { TrackballControls } from "https://esm.sh/three@0.172.0/examples/jsm/controls/TrackballControls.js";
import { Line2 } from "https://esm.sh/three@0.172.0/examples/jsm/lines/Line2.js";
import { LineMaterial } from "https://esm.sh/three@0.172.0/examples/jsm/lines/LineMaterial.js";
import { LineSegmentsGeometry } from "https://esm.sh/three@0.172.0/examples/jsm/lines/LineSegmentsGeometry.js";
import { computeBrinkSkeleton, computeBoundaryCubeFaces, logBrinkSkeleton } from "./brinkSkeleton.js";
import { fillCubesFromSkeleton } from "./realizeSkeleton.js";

// SIZE is only the coordinate bound of the editable region (used by inBounds,
// the grid helper, and the world box). It deliberately does NOT size any GPU
// buffer: the number of boundary faces and skeleton elements is bounded by the
// cubes actually placed (a surface-area quantity), never by SIZE³, so the
// InstancedMeshes below start small and grow on demand instead of preallocating
// SIZE³ instances (which was ~3.2 GB of matrix buffers at SIZE=170).
const SIZE = 170;
const HALF = Math.floor(SIZE / 2);
const MIN = -HALF;
const MAX = HALF;

// Initial per-mesh instance capacity; ensureInstanceCapacity() grows it (to the
// next power of two) whenever a render needs more.
const INITIAL_INSTANCES = 4096;

const app = document.getElementById('app');
const errorEl = document.getElementById('error');
const statusEl = document.getElementById('status');
const skeletonStatsEl = document.getElementById('skeletonStats');
const buildBtn = document.getElementById('buildBtn');
const destroyBtn = document.getElementById('destroyBtn');
const resetBtn = document.getElementById('resetBtn');
const moveBtn = document.getElementById('moveBtn');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const saveBtn = document.getElementById('saveBtn');
const saveAsBtn = document.getElementById('saveAsBtn');
const loadBtn = document.getElementById('loadBtn');
const loadAbstractBtn = document.getElementById('loadAbstractBtn');
const busyOverlay = document.getElementById('busyOverlay');
const cancelBusyBtn = document.getElementById('cancelBusyBtn');

async function main() {
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

  // Attached to the camera (rather than the scene) so they move with
  // the viewer as the camera orbits, instead of staying fixed in world
  // space. A DirectionalLight shines toward `target`, which defaults
  // to the world origin — parent the target to the camera too (at its
  // local look-at point) so the light direction stays camera-relative.
  const keyLight = new THREE.DirectionalLight(0xfff2dd, 1.2);
  keyLight.position.set(6, 9, 4);
  camera.add(keyLight);
  camera.add(keyLight.target);
  keyLight.target.position.set(0, 0, -1);

  const fillLight = new THREE.DirectionalLight(0xa8d7ff, 0.45);
  fillLight.position.set(-5, 3, -7);
  camera.add(fillLight);
  camera.add(fillLight.target);
  fillLight.target.position.set(0, 0, -1);

  scene.add(camera);

  // Per-axis colors, shared by the skeleton edges, the small boundary-cube
  // faces, and the giant boundary cube: X red, Y yellow, Z blue.
  const AXIS_COLORS = [0xff3b30, 0xffd60a, 0x0a84ff];
  // The same colors lightened ~30% toward white, used to tint the quad faces
  // so they read as a softer shade of their normal-axis color.
  const FACE_COLORS = [0xff766e, 0xffe254, 0x53a9ff];

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

  // Per-instance metadata for the current boundary faces, one array per
  // axis mesh, indexed the same as that mesh's instances.
  let boundaryFaceInfoByAxis = [[], [], []];

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
      for (let i = 0; i < axisFaces.length; i++) {
        const { sign, center } = axisFaces[i];
        const signIdx = sign === 1 ? 0 : 1;
        faceTempPosition.set(center[0], center[1], center[2]);
        faceTempMatrix.compose(faceTempPosition, faceQuaternions[axis][signIdx], faceTempScale);
        mesh.setMatrixAt(i, faceTempMatrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      // InstancedMesh caches a bounding sphere for raycasting that isn't
      // automatically invalidated when instances move or `count`
      // changes — recompute it here or hover/click detection can
      // intermittently miss instances outside the stale bounds.
      mesh.computeBoundingSphere();
    }
  }

  const hoverOutline = new THREE.Mesh(
    new THREE.PlaneGeometry(1.02, 1.02),
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, side: THREE.DoubleSide })
  );
  hoverOutline.visible = false;
  scene.add(hoverOutline);

  // --- Move mode visuals ---------------------------------------------------
  // Both the available planes and the drag indicator are drawn as the DRAGGED
  // FACE's own footprint (its set of unit quads), not generic grids: the
  // available planes show where that footprint would land at each valid
  // destination, as purple outlines in place in the column; the drag indicator
  // is an outline while free-floating and fills solid once it snaps.
  const AVAIL_PLANE_COLOR = 0x9b5cff; // purple

  // Orientation to face the footprint squares along `axis` (default normal +Z).
  const availPlaneQuaternions = [
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2), // +Z -> +X
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2), // +Z -> +Y
    new THREE.Quaternion(), // +Z -> +Z
  ];

  // The dragged face and its available destinations are drawn directly from the
  // face's brink-skeleton EDGES: `segments` are its in-plane [au,av,bu,bv] edge
  // endpoints (on the two non-edit axes). `edgePositions` lifts them into world
  // space at the given edit-axis value(s) as a flat line-segment array.
  const _segP = [0, 0, 0];
  function edgePositions(axis, segments, values) {
    const [ua, ub] = [0, 1, 2].filter((a) => a !== axis);
    const merged = [];
    for (const value of values) {
      _segP[axis] = value;
      for (const [au, av, bu, bv] of segments) {
        _segP[ua] = au;
        _segP[ub] = av;
        merged.push(_segP[0], _segP[1], _segP[2]);
        _segP[ua] = bu;
        _segP[ub] = bv;
        merged.push(_segP[0], _segP[1], _segP[2]);
      }
    }
    return merged;
  }

  // Outlines use three's fat-line classes (Line2 + LineMaterial) for genuine
  // screen-space thickness — LineBasicMaterial.linewidth is clamped to 1px by
  // WebGL. `linewidth` is in world/pixel units per LineMaterial; resolution
  // must track the canvas size (kept current on resize below). `replaceOutline`
  // swaps the LineSegmentsGeometry from a flat position array.
  const OUTLINE_LINEWIDTH = 4; // ~twice the former 1px hairline, in device px
  const DRAG_LINEWIDTH_SNAPPED = 8; // thicker + brighter when snapped to a plane
  const availableOutlineMaterial = new LineMaterial({
    color: AVAIL_PLANE_COLOR,
    linewidth: OUTLINE_LINEWIDTH,
  });
  const dragOutlineMaterial = new LineMaterial({ color: 0xd8b8ff, linewidth: OUTLINE_LINEWIDTH });
  const outlineMaterials = [availableOutlineMaterial, dragOutlineMaterial];
  function updateOutlineResolution() {
    for (const m of outlineMaterials) m.resolution.set(window.innerWidth, window.innerHeight);
  }
  updateOutlineResolution();

  function makeOutline(material, renderOrder) {
    const line = new Line2(new LineSegmentsGeometry(), material);
    line.frustumCulled = false;
    line.renderOrder = renderOrder;
    line.visible = false;
    scene.add(line);
    return line;
  }

  function replaceOutline(line, positions) {
    line.geometry.dispose();
    const geo = new LineSegmentsGeometry();
    geo.setPositions(positions);
    line.geometry = geo;
  }

  // Available planes: the dragged face's edges drawn at every valid destination
  // value (in place in the column).
  const availableOutlines = makeOutline(availableOutlineMaterial, 2);

  function showAvailablePlanes(axis, values, segments) {
    replaceOutline(availableOutlines, edgePositions(axis, segments, values));
    availableOutlines.visible = true;
  }

  function hideAvailablePlanes() {
    availableOutlines.visible = false;
  }

  // Drag indicator: the dragged face's edges, moving with the drag. Brighter
  // and thicker once it snaps to an available plane (a release would commit).
  const dragOutlineMesh = makeOutline(dragOutlineMaterial, 3);

  function renderDragIndicator(axis, segments, atValue, snapped) {
    replaceOutline(dragOutlineMesh, edgePositions(axis, segments, [atValue]));
    dragOutlineMaterial.linewidth = snapped ? DRAG_LINEWIDTH_SNAPPED : OUTLINE_LINEWIDTH;
    dragOutlineMaterial.color.set(snapped ? 0xffffff : 0xd8b8ff);
    dragOutlineMesh.visible = true;
  }

  function hideDragIndicator() {
    dragOutlineMesh.visible = false;
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
  const FACE_SOLID = 2;
  const FACE_TRANSLUCENT = 1;
  const FACE_HIDDEN = 0;
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
    saveToLocalStorage();
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

  // --- Move mode: drag a connected boundary face along its orthogonal axis --
  // `moveMode` is a single toggle. While active, ANY visible boundary face can
  // be grabbed; the axis of the face hit (its normal) becomes the drag axis, so
  // the face slides freely along that axis. Invisible (hidden) faces aren't
  // grabbable. Rendering is independent and driven entirely by per-axis face
  // visibility (see applyFaceVisibility).
  let moveMode = false;
  let currentSkeleton = null; // cached { vertices, edges, faces } from updateBrinkSkeleton

  // Squared distance from point (px,pv) to the segment (ax,av)-(bx,bv), in 2D.
  function pointSegDist2(px, pv, ax, av, bx, bv) {
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
  function normalizeSeg([au, av, bu, bv]) {
    if (av === bv) return { dir: 0, fixed: av, s0: Math.min(au, bu), s1: Math.max(au, bu) };
    return { dir: 1, fixed: au, s0: Math.min(av, bv), s1: Math.max(av, bv) };
  }

  // A face's in-plane geometry prepared for interference testing: its
  // normalized edges plus their bounding box, both in one pass.
  function prepareFace(segments) {
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
  function segmentsInterfere(a, b) {
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
  function facesInterfere(a, b) {
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
  function projectFace(skeleton, faceIdx, axis) {
    const [ua, ub] = [0, 1, 2].filter((a) => a !== axis);
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
  function buildPlaneFaceIndex(skeleton, axis, excludeKey) {
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

  // Identify the ONE brink-skeleton face (in the plane normal to the edit axis,
  // at the grabbed quad's coordinate) whose edges the grabbed quad is nearest.
  // Returns { coord, vertexIndices, segments }: the shared edit-axis coordinate,
  // the face's skeleton vertex indices (whose coordinate the drag shifts on
  // commit), and its edges as in-plane [au,av,bu,bv] segments (for the drag
  // visuals), or null if no bounding face was found.
  //
  // A single grid plane at one coord may hold SEVERAL disjoint brink-skeleton
  // face cycles — e.g. eight squares around an empty center give an outer ring
  // cycle and an inner hole cycle. By the parity construction (see
  // brinkSkeleton.js) these cycles never share an edge and touch only at
  // non-extremal points, so they are genuinely disjoint edge sets. We therefore
  // select by the ACTUAL click point: build the in-plane cycles, then pick the
  // one whose nearest edge is closest to where the ray met the grabbed quad,
  // rather than whichever the flood-fill happened to reach first.
  function connectedFace(axis, startId, hitPoint) {
    const faces = boundaryFaceInfoByAxis[axis];
    const coord = Math.round(faces[startId].center[axis]);
    const [ua, ub] = [0, 1, 2].filter((a) => a !== axis);

    // In-plane click coordinates. Fall back to the grabbed quad's center if no
    // hit point was supplied.
    const hu = hitPoint ? hitPoint.getComponent(ua) : faces[startId].center[ua];
    const hv = hitPoint ? hitPoint.getComponent(ub) : faces[startId].center[ub];

    if (!currentSkeleton) return null;

    // The in-plane face cycles at this coord, each with the info the drag needs:
    // the skeleton vertex indices to shift on commit, and its edges as in-plane
    // [au,av,bu,bv] segments for the drag visuals.
    let best = null;
    let bestDist = Infinity;
    for (let faceIdx = 0; faceIdx < currentSkeleton.faces.length; faceIdx++) {
      const projected = projectFace(currentSkeleton, faceIdx, axis);
      if (!projected || projected.coord !== coord) continue;
      // Distance from the click point to this cycle = its nearest edge.
      let dist = Infinity;
      for (const [au, av, bu, bv] of projected.segments) {
        dist = Math.min(dist, pointSegDist2(hu, hv, au, av, bu, bv));
      }
      if (dist < bestDist) {
        bestDist = dist;
        // `key` names this face independently of index order, so the commit can
        // re-resolve it against a freshly computed skeleton instead of trusting
        // indices captured when the drag began.
        best = {
          coord,
          key: currentSkeleton.faceKeys[faceIdx],
          vertexIndices: projected.vertexIndices,
          segments: projected.segments,
        };
      }
    }

    return best; // null if no in-plane bounding face was found (shouldn't happen)
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
  function computeAvailablePlanes(axis, excludeCoord, dragged, planeIndex, modelLo, modelHi) {
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
  function dragBounds(axis, vertexIndices, skeleton) {
    const [ua, ub] = [0, 1, 2].filter((a) => a !== axis);
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
  function applyGraphDrawingEdit(skeleton, faceKeys, axis, plane) {
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

  const occupied = new Map();
  const positions = [];

  // --- Undo/redo -----------------------------------------------------------
  // Each entry snapshots the Graph Drawing, which IS the model state. Cubes are
  // left out because they are derived — a restore refills them from the drawing
  // (~49ms even for the 37k-cube Klein quartic, imperceptible for an undo).
  // Face visibility and camera are left out because they are rendering choices,
  // not model state: an undo should revert your edit without disturbing how you
  // are looking at it.
  //
  // Snapshots rather than per-operation inverses: the drawing is small (3.9 KB
  // for the largest design in designs/, so even hundreds of entries cost a
  // couple of MB), and an inverse that is subtly wrong corrupts state silently,
  // which a snapshot cannot do. History is unbounded, and one stack carries
  // both graph-preserving and graph-breaking edits.
  //
  // No deep copy is needed: every producer of a skeleton (computeBrinkSkeleton,
  // applyGraphDrawingEdit) returns a fresh object with a fresh vertices array,
  // and nothing mutates a skeleton in place.
  const history = { entries: [], index: -1 }; // entries[index] is the current state

  const STORAGE_KEY = 'cubes-editor:state';
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

  // What we persist is an abstract GRAPH (edges + faces) together with a
  // DRAWING of it (vertex coordinates) — the mathematically meaningful
  // content. Cubes are a derivation of the drawing and are NOT saved: for the
  // Klein quartic that takes the file from 2106KB to 53KB, and the cubes are
  // recovered exactly on load.
  //
  // This shape is shared by the autosave and the file-save paths. Autosave
  // previously wrote `positions` on every edit, which for large models meant
  // rewriting hundreds of KB per cube; it now writes the drawing instead.
  function currentStateJSON() {
    // Persist only the graph and its drawing. The identity fields that
    // computeBrinkSkeleton also returns (ids, keys, lookup Maps) are derived —
    // and Maps would serialize to `{}` — so they stay out of the file.
    const { vertices, edges, faces } = computeBrinkSkeleton(positions);
    const state = {
      skeleton: { vertices, edges, faces },
      faceVisibility,
      camera: {
        position: camera.position.toArray(),
        target: controls.target.toArray(),
      },
    };
    return JSON.stringify(state, null, 2);
  }

  function parseSavedState(raw) {
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

      const isVector3Array = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));
      const cameraState =
        parsed.camera && isVector3Array(parsed.camera.position) && isVector3Array(parsed.camera.target)
          ? parsed.camera
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

      return { positions, faceVisibility: faceVis, camera: cameraState, skeleton };
    } catch {
      return null;
    }
  }

  function saveToLocalStorage() {
    localStorage.setItem(STORAGE_KEY, currentStateJSON());
  }

  function loadFromLocalStorage() {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? parseSavedState(raw) : null;
  }

  // File save/load: uses the File System Access API when available (so a
  // plain "Save" after the first "Save As…"/"Load…" writes straight back
  // to the same file without re-prompting); falls back to a download-link
  // trigger and a hidden file input on browsers that lack it (e.g. Safari,
  // Firefox).
  const hasFileSystemAccess = 'showSaveFilePicker' in window && 'showOpenFilePicker' in window;
  let fileHandle = null;

  async function writeToFileHandle(handle) {
    const writable = await handle.createWritable();
    await writable.write(currentStateJSON());
    await writable.close();
  }

  async function saveAs() {
    if (hasFileSystemAccess) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: 'cubes.json',
          types: [{ description: 'Cubes Editor JSON', accept: { 'application/json': ['.json'] } }],
        });
        await writeToFileHandle(handle);
        fileHandle = handle;
      } catch (error) {
        if (error?.name !== 'AbortError') console.error('Save As failed:', error);
      }
      return;
    }

    const blob = new Blob([currentStateJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cubes.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function save() {
    if (hasFileSystemAccess && fileHandle) {
      try {
        await writeToFileHandle(fileHandle);
        return;
      } catch (error) {
        console.error('Save failed, falling back to Save As:', error);
      }
    }
    await saveAs();
  }

  function applyLoadedState(state) {
    if (!state) return;

    // Swap the whole voxel set in ONE batch using the raw (non-recomputing)
    // primitives, then recompute/render the skeleton exactly once at the end.
    // Using addVoxel/removeVoxel here would recompute the brink skeleton and
    // rebuild every instanced mesh on EACH cube — O(N²) work plus N redundant
    // renders — which hangs and crashes the page on large models (e.g. a
    // 37k-cube realized skeleton).
    for (const { x, y, z } of [...positions]) removeVoxelRaw(x, y, z);
    for (const { x, y, z } of state.positions) addVoxelRaw(x, y, z);
    updateBrinkSkeleton({ record: true, label: 'Load' });

    faceVisibility.splice(0, 3, ...state.faceVisibility);
    applyFaceVisibility();

    if (state.camera) {
      camera.position.fromArray(state.camera.position);
      controls.target.fromArray(state.camera.target);
      controls.update();
    }

    updateStatus(mode);
    saveToLocalStorage();
  }

  // A saved file holds an abstract GRAPH (edges + faces) and, optionally, a
  // DRAWING of it (vertex coordinates). Cubes are a derivation, not content,
  // so a plain open resolves on what the file actually carries:
  //   graph + drawing -> fill cubes from the drawing (authoritative even when
  //                      legacy `positions` are also present)
  //   graph, no drawing -> realize coordinates, then fill
  //   positions only    -> legacy file: load the cubes directly
  // The explicit 'skeleton' and 'abstract' gestures remain as OVERRIDES —
  // loading a drawn graph *as* abstract, to re-realize its coordinates, is a
  // meaningful thing to ask for.
  //
  // Whatever the route, the applied `positions` become the in-memory cube
  // cache backing rendering, picking, and export; the app re-derives the
  // skeleton from them on load.
  const dropOutOfBounds = (cubes) => {
    const kept = cubes.filter((c) => inBounds(c.x, c.y, c.z));
    if (kept.length !== cubes.length) {
      console.warn(`Load: ${cubes.length - kept.length} recovered cube(s) fell outside bounds and were dropped.`);
    }
    return kept;
  };

  // Does this state carry a usable drawing (a graph with real coordinates)?
  const hasDrawing = (state) => Boolean(state.skeleton && state.skeleton.vertices.length);

  // Synchronous cube derivation for the 'cubes' and 'skeleton' gestures (both
  // fast). The 'abstract' gesture is handled separately via a worker because
  // its coordinate realization can be slow — see realizeAbstract().
  function derivePositionsSync(state, interpretation) {
    // A plain open prefers the drawing over any stored cubes: the drawing is
    // the content, the cubes a derivation of it. Old files carry both.
    if (interpretation === 'cubes') {
      if (!hasDrawing(state)) return state.positions;
      try {
        return dropOutOfBounds(fillCubesFromSkeleton(state.skeleton));
      } catch (error) {
        console.error('Load failed while filling cubes from the drawing:', error);
        return state.positions; // fall back to stored cubes if present
      }
    }
    if (!state.skeleton) {
      console.error(`Load failed: file has no skeleton to load as "${interpretation}".`);
      return null;
    }
    // The 'skeleton' gesture fills from real coordinates; an abstract-only
    // skeleton (a graph with a vertex count but no coordinate array) has none —
    // it can only be loaded via the 'abstract' gesture, which re-realizes them.
    if (!state.skeleton.vertices.length && state.skeleton.vertexCount > 0) {
      console.error('Load failed: skeleton has no vertex coordinates; use "Load Abstract" instead.');
      return null;
    }
    try {
      // 'skeleton' fills the file's concrete skeleton directly (exact
      // round-trip).
      const cubes = fillCubesFromSkeleton(state.skeleton);
      return dropOutOfBounds(cubes);
    } catch (error) {
      console.error(`Load failed while recovering cubes (${interpretation}):`, error);
      return null;
    }
  }

  // --- Abstract realization worker ---------------------------------------
  // The abstract gesture strips the skeleton's coordinates and re-realizes
  // them, then fills cubes. Realization backtracks to find a valid slab
  // ordering and can take seconds on large models, so it runs in a worker to
  // keep the UI responsive; the worker can be terminated to cancel. NOTE:
  // BEST-EFFORT — an abstract skeleton underdetermines geometry, so the
  // recovered solid has a skeleton isomorphic to the input but may differ in
  // shape/pose from the original.
  let busy = false;
  function setBusy(on) {
    busy = on;
    busyOverlay.hidden = !on;
  }

  let realizeWorker = null;
  let realizeReject = null; // reject fn of the in-flight realization, if any

  function realizeAbstract(skeleton) {
    return new Promise((resolve, reject) => {
      realizeWorker = new Worker(new URL('./realizeWorker.js', import.meta.url), { type: 'module' });
      realizeReject = reject;
      realizeWorker.onmessage = (event) => {
        const { cubes, error } = event.data;
        teardownWorker();
        if (error) reject(new Error(error));
        else resolve(cubes);
      };
      realizeWorker.onerror = (event) => {
        teardownWorker();
        reject(new Error(event.message || 'Realization worker failed'));
      };
      realizeWorker.postMessage({ skeleton });
    });
  }

  function teardownWorker() {
    if (realizeWorker) {
      realizeWorker.terminate();
      realizeWorker = null;
    }
    realizeReject = null;
  }

  function cancelRealization() {
    if (realizeReject) {
      const reject = realizeReject;
      teardownWorker();
      reject(new Error('cancelled'));
    }
  }

  async function applyLoadedFile(state, interpretation) {
    // A plain open of a file that carries a graph but NO drawing has to
    // realize coordinates first — the same work the explicit 'abstract'
    // gesture does, so route it there rather than failing for want of cubes.
    if (interpretation === 'cubes' && !hasDrawing(state) && state.skeleton?.vertexCount > 0 && !state.positions.length) {
      interpretation = 'abstract';
    }

    if (interpretation === 'abstract') {
      if (!state.skeleton) {
        console.error('Load failed: file has no skeleton to load as "abstract".');
        return;
      }
      console.warn(
        'Load Abstract is best-effort: coordinates are re-realized from the ' +
          'coordinate-free graph, recovering some solid with an isomorphic ' +
          'skeleton — not necessarily the original shape or pose.'
      );
      setBusy(true);
      try {
        const cubes = await realizeAbstract(state.skeleton);
        applyLoadedState({ ...state, positions: dropOutOfBounds(cubes) });
      } catch (error) {
        if (error?.message !== 'cancelled') {
          console.error('Load failed while realizing abstract skeleton:', error);
        }
      } finally {
        setBusy(false);
      }
      return;
    }

    const positions = derivePositionsSync(state, interpretation);
    if (!positions) return;
    applyLoadedState({ ...state, positions });
  }

  let fileInput = null;
  let pendingInterpretation = 'cubes';

  async function load(interpretation = 'cubes') {
    if (hasFileSystemAccess) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'Cubes Editor JSON', accept: { 'application/json': ['.json'] } }],
        });
        const file = await handle.getFile();
        const state = parseSavedState(await file.text());
        if (!state) {
          console.error('Load failed: file is not a valid cubes-editor save.');
          return;
        }
        // Only track the file handle for write-back on a plain cubes load; a
        // skeleton/abstract load derives a fresh model that shouldn't quietly
        // overwrite the source file on the next Save.
        fileHandle = interpretation === 'cubes' ? handle : null;
        await applyLoadedFile(state, interpretation);
      } catch (error) {
        if (error?.name !== 'AbortError') console.error('Load failed:', error);
      }
      return;
    }

    pendingInterpretation = interpretation;
    if (!fileInput) {
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'application/json';
      fileInput.style.display = 'none';
      document.body.appendChild(fileInput);
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        const state = parseSavedState(await file.text());
        if (!state) {
          console.error('Load failed: file is not a valid cubes-editor save.');
          return;
        }
        await applyLoadedFile(state, pendingInterpretation);
      });
    }
    fileInput.click();
  }

  function key(x, y, z) {
    return `${x},${y},${z}`;
  }

  function inBounds(x, y, z) {
    return x >= MIN && x <= MAX && y >= MIN && y <= MAX && z >= MIN && z <= MAX;
  }

  function hasVoxel(x, y, z) {
    return occupied.has(key(x, y, z));
  }

  function updateStatus(mode) {
    const label = moveMode ? 'Move' : mode === 'build' ? 'Build' : 'Destroy';
    statusEl.innerHTML = `Mode: ${label}<br>Cubes: ${positions.length}`;
  }

  // A graph is bipartite iff it has no odd-length cycle. 2-color each
  // connected component by BFS; a conflict (neighbor wants the same color)
  // means an odd cycle exists.
  function isBipartite(vertexCount, edges) {
    const adjacency = Array.from({ length: vertexCount }, () => []);
    for (const [a, b] of edges) {
      adjacency[a].push(b);
      adjacency[b].push(a);
    }
    const color = new Array(vertexCount).fill(-1);
    for (let start = 0; start < vertexCount; start++) {
      if (color[start] !== -1) continue;
      color[start] = 0;
      const queue = [start];
      while (queue.length > 0) {
        const v = queue.shift();
        for (const n of adjacency[v]) {
          if (color[n] === -1) {
            color[n] = 1 - color[v];
            queue.push(n);
          } else if (color[n] === color[v]) {
            return false;
          }
        }
      }
    }
    return true;
  }

  // Push a new state, discarding any redo tail: editing after an undo forks
  // history, and the abandoned branch is gone.
  function recordHistory(skeleton, label) {
    history.entries.length = history.index + 1;
    history.entries.push({ label, skeleton });
    history.index = history.entries.length - 1;
    updateHistoryButtons();
  }

  const canUndo = () => history.index > 0;
  const canRedo = () => history.index < history.entries.length - 1;

  function updateHistoryButtons() {
    undoBtn.disabled = !canUndo();
    redoBtn.disabled = !canRedo();
    undoBtn.title = canUndo() ? `Undo ${history.entries[history.index].label}` : 'Nothing to undo';
    redoBtn.title = canRedo() ? `Redo ${history.entries[history.index + 1].label}` : 'Nothing to redo';
  }

  // Restore a recorded state. Cubes are refilled from the drawing rather than
  // stored, using the raw primitives plus a single adoptSkeleton — a per-cube
  // addVoxel loop here would be O(N²) and rebuild every InstancedMesh per cube.
  function restoreHistory(i) {
    const { skeleton } = history.entries[i];
    history.index = i;
    try {
      const cubes = dropOutOfBounds(fillCubesFromSkeleton(skeleton));
      for (const { x, y, z } of [...positions]) removeVoxelRaw(x, y, z);
      for (const { x, y, z } of cubes) addVoxelRaw(x, y, z);
    } catch (error) {
      console.error('Undo/redo failed while refilling cubes from the drawing:', error);
      updateBrinkSkeleton(); // cubes may be half-swapped: re-derive from them
      return;
    }
    // adoptSkeleton renders the cube geometry from `positions`, so the refill
    // above must already have happened. Not recorded: restoring is not an edit.
    adoptSkeleton(skeleton);
    updateHistoryButtons();
    updateStatus(mode);
  }

  function undo() {
    if (canUndo()) restoreHistory(history.index - 1);
  }

  function redo() {
    if (canRedo()) restoreHistory(history.index + 1);
  }

  // Adopt an ALREADY-KNOWN skeleton as the current one: render it, restate the
  // topology readout, rebuild the cube-face geometry, and persist. Deliberately
  // does NOT derive the graph — a graph-preserving edit already holds the
  // graph, and re-deriving it would be both wasteful and lossy (see
  // applyGraphDrawingEdit).
  //
  // `record` is explicit rather than inferred: this function is also called for
  // non-edits — resyncing the render after a failed drag, and seeding the
  // initial state — which must not become undoable steps.
  function adoptSkeleton(skeleton, { record = false, label = '' } = {}) {
    if (record) recordHistory(skeleton, label);
    currentSkeleton = skeleton;
    // logBrinkSkeleton(skeleton);
    renderBrinkSkeleton(skeleton);
    const V = skeleton.vertices.length;
    const E = skeleton.edges.length;
    const F = skeleton.faces.length;
    const bipartite = isBipartite(V, skeleton.edges);
    skeletonStatsEl.innerHTML =
      `Skeleton: V ${V}, E ${E}, F ${F}<br>Euler χ: ${V - E + F}<br>` +
      `Orientable: ${bipartite ? 'yes' : 'no'}`;
    renderBoundaryCubeFaces(positions);
    saveToLocalStorage();
  }

  // The graph-BREAKING path: the cubes are ground truth, so derive the graph
  // from them and adopt the result. Every voxel add/remove, reset, and load
  // goes through here.
  function updateBrinkSkeleton(options) {
    adoptSkeleton(computeBrinkSkeleton(positions), options);
  }

  function reset() {
    // Batch: raw removes/add, then one recompute/render. A per-cube
    // removeVoxel loop is O(N²) and rebuilds every InstancedMesh per cube,
    // which locks up on large models (e.g. a 37k-cube loaded skeleton).
    for (const { x, y, z } of [...positions]) removeVoxelRaw(x, y, z);
    addVoxelRaw(0, 0, 0);
    updateBrinkSkeleton({ record: true, label: 'Reset' });
    updateStatus(mode);
  }

  function addVoxel(x, y, z) {
    if (!inBounds(x, y, z) || hasVoxel(x, y, z)) return false;

    const idx = positions.length;
    const pos = { x, y, z };
    positions.push(pos);
    occupied.set(key(x, y, z), idx);

    updateBrinkSkeleton({ record: true, label: 'Add cube' });
    return true;
  }

  function removeVoxel(x, y, z) {
    const removeKey = key(x, y, z);
    const removeIdx = occupied.get(removeKey);
    if (removeIdx === undefined) return false;

    const lastIdx = positions.length - 1;
    const lastPos = positions[lastIdx];

    if (removeIdx !== lastIdx) {
      positions[removeIdx] = lastPos;
      occupied.set(key(lastPos.x, lastPos.y, lastPos.z), removeIdx);
    }

    positions.pop();
    occupied.delete(removeKey);
    updateBrinkSkeleton({ record: true, label: 'Remove cube' });
    return true;
  }

  // Presence toggles that DON'T recompute the skeleton — for batched edits
  // (e.g. a face-move sweeping many cells) where the caller recomputes once at
  // the end via updateBrinkSkeleton(). Same swap-pop bookkeeping as
  // add/removeVoxel, just without the per-cell recompute.
  function addVoxelRaw(x, y, z) {
    if (!inBounds(x, y, z) || hasVoxel(x, y, z)) return false;
    occupied.set(key(x, y, z), positions.length);
    positions.push({ x, y, z });
    return true;
  }

  function removeVoxelRaw(x, y, z) {
    const removeKey = key(x, y, z);
    const removeIdx = occupied.get(removeKey);
    if (removeIdx === undefined) return false;
    const lastIdx = positions.length - 1;
    const lastPos = positions[lastIdx];
    if (removeIdx !== lastIdx) {
      positions[removeIdx] = lastPos;
      occupied.set(key(lastPos.x, lastPos.y, lastPos.z), removeIdx);
    }
    positions.pop();
    occupied.delete(removeKey);
    return true;
  }

  // Load a design from a URL given as the `design` query parameter — both
  // absolute (?design=https://host/path/cubes.json) and relative
  // (?design=designs/cubes.json) URLs are supported. Takes precedence over
  // the autosaved localStorage state. Loaded via the same parse path as
  // file loads and applied as a plain 'cubes' load (skeleton re-derived).
  async function loadFromDesignParam() {
    const raw = new URLSearchParams(window.location.search).get('design');
    if (!raw) return null;
    // Resolve against the page URL so a relative value fetches from the
    // right base regardless of the current path; new URL(raw, base) accepts
    // absolute URLs unchanged and turns relative ones into absolute.
    const url = new URL(raw, window.location.href).href;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const state = parseSavedState(await response.text());
      if (!state) {
        throw new Error('not a valid cubes-editor save');
      }
      return state;
    } catch (error) {
      console.error(`Load from ?design=${url} failed:`, error);
      errorEl.style.display = 'grid';
      errorEl.textContent = `Load from design URL failed: ${error?.message || error}`;
      return null;
    }
  }

  // Restore previously saved state, if any: face visibility and camera first
  // (so the position-restoring addVoxel calls below, which each trigger a
  // save, re-persist the already-correct values instead of clobbering
  // them with defaults), then the assembly itself. A `design` URL param, if
  // present and valid, overrides the autosaved localStorage state. With
  // nothing saved, fall back to a single cube centered in the build volume.
  const saved = (await loadFromDesignParam()) ?? loadFromLocalStorage();

  if (saved?.camera) {
    camera.position.fromArray(saved.camera.position);
    controls.target.fromArray(saved.camera.target);
    controls.update();
  }

  if (saved?.faceVisibility) faceVisibility.splice(0, 3, ...saved.faceVisibility);
  applyFaceVisibility();

  // Restore the initial voxel set in ONE batch (raw adds, then a single
  // recompute/render) — a per-cube addVoxel loop here is O(N²) and rebuilds
  // every InstancedMesh per cube, hanging startup on large saved models.
  // Autosaves now carry the drawing rather than the cubes, but an autosave
  // written by an older build (positions only) must still restore — so accept
  // either shape, preferring the drawing.
  const restored = saved
    ? hasDrawing(saved)
      ? dropOutOfBounds(fillCubesFromSkeleton(saved.skeleton))
      : saved.positions
    : null;

  if (restored?.length) {
    for (const { x, y, z } of restored) addVoxelRaw(x, y, z);
  } else {
    addVoxelRaw(0, 0, 0);
  }
  // Seed history with the starting state so the first undo has somewhere to
  // return to. Recorded as the base entry, not as an edit the user made.
  updateBrinkSkeleton({ record: true, label: 'Initial state' });

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  let mode = 'build';
  let downX = 0;
  let downY = 0;

  function setMode(nextMode) {
    mode = nextMode;
    setMoveMode(false); // Build/Destroy and Move are mutually exclusive
    buildBtn.classList.toggle('active', mode === 'build');
    destroyBtn.classList.toggle('active', mode === 'destroy');
    updateStatus(mode);
  }

  function setMoveMode(on) {
    if (moveMode === on) return;
    cancelDrag();
    moveMode = on;
    moveBtn.classList.toggle('active', on);
    // Rendering is decoupled from the move gesture: face visibility stays in
    // effect whether or not move mode is active.
    if (!on) {
      hideAvailablePlanes();
    } else {
      // Leaving Build/Destroy: drop their active styling and status.
      buildBtn.classList.remove('active');
      destroyBtn.classList.remove('active');
      hoverOutline.visible = false;
      updateStatus(mode);
    }
  }

  function toggleMoveMode() {
    setMoveMode(!moveMode);
  }

  function getIntersection(clientX, clientY, meshes = cubeFaceMeshes) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    // intersectObjects raycasts every mesh passed directly in the array
    // regardless of its `.visible` flag (visibility is only honored when
    // descending into CHILDREN during recursive traversal). Filter to visible
    // meshes ourselves so hidden faces aren't pickable — letting clicks and
    // hover pass through to interior orthogonal faces behind them.
    return raycaster.intersectObjects(meshes.filter((m) => m.visible), false);
  }

  function handleEdit(clientX, clientY) {
    if (busy) return; // edits are suspended while a realization runs
    const hits = getIntersection(clientX, clientY);

    // A click that misses every small boundary-cube face falls through to the
    // giant boundary cube: hitting one of its faces cycles that axis's face
    // visibility (solid -> translucent -> hidden). Checked before the move-mode
    // early return so this rendering control works in any editing mode. The
    // ray crosses two walls (the box faces are DoubleSide), returned sorted
    // near->far; take the LAST so we cycle the FAR face the user actually sees,
    // not the near wall in front of the camera.
    if (!hits.length) {
      const boxHits = getIntersection(clientX, clientY, [boundsBox]);
      const farHit = boxHits[boxHits.length - 1];
      if (farHit && farHit.face) {
        cycleFaceVisibility(farHit.face.materialIndex >> 1);
      }
      return;
    }

    if (moveMode) return; // move mode has its own drag interaction

    const hit = hits[0];
    const id = hit.instanceId;
    if (id === undefined || id === null) return;

    const axis = cubeFaceMeshes.indexOf(hit.object);
    const info = boundaryFaceInfoByAxis[axis]?.[id];
    if (!info) return;
    const { x, y, z } = positions[info.cubeIndex];

    if (mode === 'destroy') {
      if (removeVoxel(x, y, z)) updateStatus(mode);
      return;
    }

    const nx = x + (info.axis === 0 ? info.sign : 0);
    const ny = y + (info.axis === 1 ? info.sign : 0);
    const nz = z + (info.axis === 2 ? info.sign : 0);

    if (addVoxel(nx, ny, nz)) updateStatus(mode);
  }

  // --- Move-mode drag state and geometry -----------------------------------
  const SNAP_THRESHOLD = 0.3; // commit only if drag value is within this of a plane
  let drag = null; // { axis, face, skeleton, planes, linePoint, dragValue }
  // A grabbed-but-trapped face (grabbable, but with no legal destination): the
  // gesture is consumed and its impeders shown, but there is no live drag.
  let trapped = false;

  // Closest edit-axis value on the line through `linePoint` (parallel to
  // `axis`) to the pointer ray — the drag value. Derived by minimizing the
  // distance between the ray and that axis-parallel line.
  const _rayOrigin = new THREE.Vector3();
  const _rayDir = new THREE.Vector3();
  function dragValueFromRay(clientX, clientY, axis, linePoint) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    _rayOrigin.copy(raycaster.ray.origin);
    _rayDir.copy(raycaster.ray.direction);

    // Line L: linePoint + t*e_axis. Ray R: o + s*d. Solve for t minimizing
    // |R - L|^2. With e a unit basis vector, using the standard closest-points
    // -of-two-lines formula.
    const e = [0, 0, 0];
    e[axis] = 1;
    const d = [_rayDir.x, _rayDir.y, _rayDir.z];
    const o = [_rayOrigin.x, _rayOrigin.y, _rayOrigin.z];
    // w0 points from the ray's origin to the axis line's point; the standard
    // two-line closest-approach formula below is written for this direction
    // (the reverse, o - linePoint, negates t and drags the face backward).
    const w0 = [linePoint[0] - o[0], linePoint[1] - o[1], linePoint[2] - o[2]];
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const a = 1; // dot(e,e)
    const b = dot(e, d);
    const c = dot(d, d);
    const dd = dot(e, w0);
    const ee = dot(d, w0);
    const denom = a * c - b * b;
    // t is the parameter along the axis line (the value offset from linePoint).
    const t = Math.abs(denom) < 1e-8 ? 0 : (b * ee - c * dd) / denom;
    return linePoint[axis] + t;
  }

  function nearestPlane(value, planes) {
    let best = null;
    let bestDist = Infinity;
    for (const p of planes) {
      const dist = Math.abs(p - value);
      if (dist < bestDist) {
        bestDist = dist;
        best = p;
      }
    }
    return { plane: best, dist: bestDist };
  }

  function startDrag(axis, hitId, hitPoint) {
    const face = connectedFace(axis, hitId, hitPoint);
    if (!face) return false; // not a grabbable face: let the gesture rotate the camera
    // Candidate destination planes — those where the arriving cycle would touch
    // none of the plane's residents — then discard any that would drive a
    // dragged vertex past a collinear neighbor on its DRAG-AXIS line
    // (overlapping the neighboring edge). The two constraints are independent:
    // the in-plane interference test cannot see an overlap along the drag axis,
    // and dragBounds cannot see one within the destination plane.
    const dragged = prepareFace(face.segments);
    const { index, lo: modelLo, hi: modelHi } = buildPlaneFaceIndex(currentSkeleton, axis, face.key);
    const { lo, hi, impeders } = dragBounds(axis, face.vertexIndices, currentSkeleton);
    const values = computeAvailablePlanes(axis, face.coord, dragged, index, modelLo, modelHi)
      .filter((v) => v > lo && v < hi);
    if (!values.length) {
      // The face is grabbable but boxed in by its collinear neighbors, so there
      // is nowhere legal to move. Still CONSUME the gesture (suspend the
      // trackball) and show the impeders, so it reads as "trapped, here's why"
      // instead of an unexpected camera rotation. No live `drag`:
      // pointermove/up just clear the preview.
      //
      // The impeders are a COMPLETE explanation: interference alone can never
      // empty this list. The candidate range always reaches modelHi + 1 and
      // modelLo - 1, where no skeleton vertex — hence no resident face —
      // exists, so those two planes are unconditionally interference-free.
      // Only dragBounds can cut them off (or, for a model pressed against the
      // world wall, the MIN/MAX clamp, where inBounds is already the operative
      // constraint). Interference can still punch holes in the middle of the
      // reachable interval; it just cannot close both ends.
      trapped = true;
      controls.enabled = false;
      showImpeders(impeders);
      return true;
    }

    // A point on the face (a segment endpoint lifted into the current plane)
    // gives the axis-parallel line the pointer ray is projected onto.
    const [ua, ub] = [0, 1, 2].filter((a) => a !== axis);
    const linePoint = [0, 0, 0];
    linePoint[axis] = face.coord;
    linePoint[ua] = face.segments[0][0];
    linePoint[ub] = face.segments[0][1];

    drag = {
      axis,
      face,
      skeleton: currentSkeleton, // the graph the drag edits, resolved by face key at commit
      planes: values,
      linePoint,
      dragValue: face.coord,
    };
    controls.enabled = false;
    showAvailablePlanes(axis, values, face.segments);
    showImpeders(impeders);
    renderDragIndicator(axis, face.segments, face.coord, false);
    return true;
  }

  function updateDrag(clientX, clientY) {
    const value = dragValueFromRay(clientX, clientY, drag.axis, drag.linePoint);
    drag.dragValue = value;
    const { plane, dist } = nearestPlane(value, drag.planes);
    // Within the snap threshold the indicator snaps to the plane and brightens
    // (a release would commit there); otherwise it follows the raw value so
    // dragging past a plane can reach the next one.
    const snapped = dist <= SNAP_THRESHOLD;
    renderDragIndicator(drag.axis, drag.face.segments, snapped ? plane : value, snapped);
  }

  function commitDrag() {
    const { axis, face, skeleton, dragValue, planes } = drag;
    const { plane, dist } = nearestPlane(dragValue, planes);
    endDrag();
    if (plane === null || dist > SNAP_THRESHOLD) return; // not near a plane: cancel
    if (plane === face.coord) return;

    // A graph-preserving edit: shift the dragged face's vertices to the target
    // plane, keeping the graph itself. The face is named by KEY — by its edge
    // cycle rather than by position in the face array — so we move the face we
    // grabbed or nothing at all, never whichever face inherited its index.
    const modifiedSkeleton = applyGraphDrawingEdit(skeleton, [face.key], axis, plane);
    if (!modifiedSkeleton) {
      console.warn('Face drag: the move is not graph-preserving; ignoring the drag.');
      adoptSkeleton(skeleton); // resync render to the unchanged skeleton
      return;
    }

    try {
      // Cubes are derived purely to render, pick, and export — they are not
      // consulted to rebuild the graph, so `adoptSkeleton` (not
      // `updateBrinkSkeleton`) takes the graph we already hold.
      const cubes = dropOutOfBounds(fillCubesFromSkeleton(modifiedSkeleton));
      for (const { x, y, z } of [...positions]) removeVoxelRaw(x, y, z);
      for (const { x, y, z } of cubes) addVoxelRaw(x, y, z);
      adoptSkeleton(modifiedSkeleton, { record: true, label: 'Move face' });
      updateStatus(mode);
    } catch (error) {
      console.error('Face drag failed while re-filling from skeleton:', error);
      updateBrinkSkeleton(); // cubes may be half-swapped: re-derive from them
    }
  }

  function endDrag() {
    drag = null;
    trapped = false;
    controls.enabled = true;
    hideDragIndicator();
    hideAvailablePlanes();
    hideImpeders();
  }

  function cancelDrag() {
    if (drag || trapped) endDrag();
  }

  buildBtn.addEventListener('click', () => setMode('build'));
  destroyBtn.addEventListener('click', () => setMode('destroy'));
  resetBtn.addEventListener('click', () => reset());
  moveBtn.addEventListener('click', () => toggleMoveMode());
  undoBtn.addEventListener('click', () => undo());
  redoBtn.addEventListener('click', () => redo());

  saveBtn.addEventListener('click', () => save());
  saveAsBtn.addEventListener('click', () => saveAs());
  loadBtn.addEventListener('click', () => load('cubes'));
  loadAbstractBtn.addEventListener('click', () => load('abstract'));
  cancelBusyBtn.addEventListener('click', () => cancelRealization());

  // Cmd/Ctrl+Z to undo, Cmd/Ctrl+Shift+Z or Ctrl+Y to redo. Suspended while a
  // realization is running or a drag is in flight, matching the edit guards.
  window.addEventListener('keydown', (event) => {
    if (busy || drag || trapped) return;
    const accel = event.metaKey || event.ctrlKey;
    if (!accel) return;
    const key = event.key.toLowerCase();
    if (key === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (key === 'y') {
      event.preventDefault();
      redo();
    }
  });

  renderer.domElement.addEventListener('pointerdown', (event) => {
    downX = event.clientX;
    downY = event.clientY;

    // In move mode, grabbing ANY visible boundary face starts a drag along that
    // face's normal axis, and suspends the trackball so the camera doesn't
    // rotate mid-drag. The axis is whichever face mesh was hit.
    if (moveMode && !busy) {
      const hit = getIntersection(event.clientX, event.clientY)[0];
      if (hit && hit.instanceId !== undefined && hit.instanceId !== null) {
        const axis = cubeFaceMeshes.indexOf(hit.object);
        if (axis !== -1 && startDrag(axis, hit.instanceId, hit.point)) {
          hoverOutline.visible = false;
          event.preventDefault();
        }
      }
    }
  });

  renderer.domElement.addEventListener('pointermove', (event) => {
    if (drag) {
      updateDrag(event.clientX, event.clientY);
      return;
    }

    // Hover highlight over any grabbable (visible) boundary face — the same set
    // in move mode and in build/destroy, since move now grabs any visible face.
    const hits = getIntersection(event.clientX, event.clientY);
    if (!hits.length || hits[0].instanceId === undefined || hits[0].instanceId === null) {
      hoverOutline.visible = false;
      return;
    }

    hits[0].object.getMatrixAt(hits[0].instanceId, hoverOutline.matrix);
    hoverOutline.matrix.decompose(hoverOutline.position, hoverOutline.quaternion, hoverOutline.scale);
    // Nudge along the face normal so the (coplanar) outline doesn't z-fight
    // with the boundary face quad it's highlighting.
    hoverOutline.translateZ(0.002);
    hoverOutline.visible = true;
  });

  renderer.domElement.addEventListener('pointerup', (event) => {
    if (drag) {
      commitDrag();
      return;
    }
    if (trapped) {
      endDrag(); // clear the trapped-face preview; nothing to commit
      return;
    }
    const dist = Math.hypot(event.clientX - downX, event.clientY - downY);
    if (dist > 3) return;
    handleEdit(event.clientX, event.clientY);
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    // Fat lines need their pixel resolution kept in sync with the canvas.
    updateOutlineResolution();
    // Unlike OrbitControls, TrackballControls caches the canvas's screen
    // rect for its rotate/pan/zoom math and needs to be told explicitly
    // when it changes, or dragging becomes misaligned with the cursor.
    controls.handleResize();
  });

  updateStatus(mode);

  // OrbitControls fires "change" continuously while dragging or during
  // damped inertial settling — debounce so camera moves don't spam
  // localStorage writes on every frame, only once motion has settled.
  let cameraSaveTimeout = null;
  controls.addEventListener('change', () => {
    clearTimeout(cameraSaveTimeout);
    cameraSaveTimeout = setTimeout(saveToLocalStorage, 300);
  });

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}

main().catch((error) => {
  console.error(error);
  errorEl.style.display = 'grid';
  errorEl.textContent = `Startup failed: ${error?.message || error}`;
});
