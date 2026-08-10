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
const moveBtns = [
  document.getElementById('moveRedBtn'),
  document.getElementById('moveYellowBtn'),
  document.getElementById('moveBlueBtn'),
];
const saveBtn = document.getElementById('saveBtn');
const saveAsBtn = document.getElementById('saveAsBtn');
const loadBtn = document.getElementById('loadBtn');
const loadSkeletonBtn = document.getElementById('loadSkeletonBtn');
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
  // `moveAxis` is null outside move mode, else 0/1/2 (X=red, Y=yellow, Z=blue).
  // Move mode only governs which faces are grabbable — the boundary faces whose
  // NORMAL is the edit axis (those never contain an edit-axis edge, so they can
  // be grabbed and dragged freely along that axis). Rendering is independent and
  // driven entirely by per-axis face visibility (see applyFaceVisibility).
  let moveAxis = null;
  let currentSkeleton = null; // cached { vertices, edges, faces } from updateBrinkSkeleton

  // Identify the ONE brink-skeleton face (in the plane normal to the edit axis,
  // at the grabbed quad's coordinate) that the grabbed quad belongs to. Returns
  // { coord, vertexIndices, segments }: the shared edit-axis coordinate, the
  // face's skeleton vertex indices (whose coordinate the drag shifts on commit),
  // and its edges as in-plane [au,av,bu,bv] segments (for the drag visuals), or
  // null if no bounding face was found.
  //
  // Algorithm (per the brink-skeleton parity rules): flood-fill EDGE-ADJACENT
  // squares, never crossing an in-plane skeleton edge (a wall). A fill region
  // either (A) reaches a skeleton VERTEX — which pins the containing face, and
  // we STOP: the face is all the commit and visuals need — or (B) exhausts as a
  // rectangle without one (e.g. an arm of a crossing where the bounding vertices
  // cancelled by parity), whereupon we corner-jump into the next region. Jumping
  // only NON-vertex corners (a diagonal there passes two walls at once, legal;
  // over a vertex would cross a single wall) keeps the search inside the one
  // face by the parity invariants — perpendicular crossing faces aren't merged.
  function connectedFace(axis, startId) {
    const faces = boundaryFaceInfoByAxis[axis];
    const coord = Math.round(faces[startId].center[axis]);
    const [ua, ub] = [0, 1, 2].filter((a) => a !== axis);

    // Squares at this coordinate, keyed by in-plane integer least corner "u,v"
    // (a quad center is the cube center in-plane, so least corner = center-0.5).
    const squareId = new Map(); // "u,v" -> instance id
    const uvOf = new Map(); // instance id -> [u, v]
    for (let id = 0; id < faces.length; id++) {
      if (Math.round(faces[id].center[axis]) !== coord) continue;
      const u = Math.round(faces[id].center[ua] - 0.5);
      const v = Math.round(faces[id].center[ub] - 0.5);
      squareId.set(`${u},${v}`, id);
      uvOf.set(id, [u, v]);
    }

    // In-plane skeleton data. IMPORTANT: a skeleton edge pairs CONSECUTIVE
    // extremal vertices along a line, so it can span MANY unit cells and pass
    // through intermediate non-vertex lattice points. We decompose every
    // in-plane edge into its UNIT segments so per-cell wall lookups match, and
    // key each unit segment canonically by its two endpoints.
    const segKey = (au, av, bu, bv) =>
      au < bu || (au === bu && av <= bv) ? `${au},${av}|${bu},${bv}` : `${bu},${bv}|${au},${av}`;
    const walls = new Set(); // unit wall segments
    const planeVertices = new Set(); // "u,v" of skeleton vertices in this plane
    // Each in-plane face cycle, with the info the drag needs: the skeleton
    // vertex indices to shift on commit, and its edges as in-plane [au,av,bu,bv]
    // segments for the drag visuals. `faceAtVertex` maps a vertex "u,v" to the
    // cycle(s) through it, so a reached vertex pins the containing face.
    const planeFaces = []; // [{ vertexIndices:[], segments:[[au,av,bu,bv]] }]
    const faceAtVertex = new Map(); // "u,v" -> planeFaces index
    if (currentSkeleton) {
      for (const [vi, vj] of currentSkeleton.edges) {
        const a = currentSkeleton.vertices[vi];
        const b = currentSkeleton.vertices[vj];
        if (Math.round(a[axis]) !== coord || Math.round(b[axis]) !== coord) continue;
        const au = Math.round(a[ua]);
        const av = Math.round(a[ub]);
        const bu = Math.round(b[ua]);
        const bv = Math.round(b[ub]);
        // Walk the (axis-aligned) edge one unit at a time.
        const stepU = Math.sign(bu - au);
        const stepV = Math.sign(bv - av);
        let cu = au;
        let cv = av;
        while (cu !== bu || cv !== bv) {
          walls.add(segKey(cu, cv, cu + stepU, cv + stepV));
          cu += stepU;
          cv += stepV;
        }
      }
      for (const p of currentSkeleton.vertices) {
        if (Math.round(p[axis]) === coord) planeVertices.add(`${Math.round(p[ua])},${Math.round(p[ub])}`);
      }
      for (const faceEdges of currentSkeleton.faces) {
        const vertexIndices = new Set();
        const segments = [];
        let inPlane = true;
        for (const ei of faceEdges) {
          const [vi, vj] = currentSkeleton.edges[ei];
          const a = currentSkeleton.vertices[vi];
          const b = currentSkeleton.vertices[vj];
          if (Math.round(a[axis]) !== coord || Math.round(b[axis]) !== coord) {
            inPlane = false;
            break;
          }
          vertexIndices.add(vi);
          vertexIndices.add(vj);
          segments.push([Math.round(a[ua]), Math.round(a[ub]), Math.round(b[ua]), Math.round(b[ub])]);
        }
        if (!inPlane || !segments.length) continue;
        const faceIdx = planeFaces.length;
        planeFaces.push({ vertexIndices: [...vertexIndices], segments });
        for (const vk of vertexIndices) {
          const p = currentSkeleton.vertices[vk];
          faceAtVertex.set(`${Math.round(p[ua])},${Math.round(p[ub])}`, faceIdx);
        }
      }
    }

    // Is there a unit wall between corner points (au,av) and (bu,bv)?
    const isWall = (au, av, bu, bv) => walls.has(segKey(au, av, bu, bv));

    // Unit wall segment separating square (u,v) from its (du,dv) edge-neighbour.
    const sharedWall = (u, v, du, dv) => {
      if (du === 1) return isWall(u + 1, v, u + 1, v + 1);
      if (du === -1) return isWall(u, v, u, v + 1);
      if (dv === 1) return isWall(u, v + 1, u + 1, v + 1);
      return isWall(u, v, u + 1, v);
    };

    const filled = new Set(); // instance ids visited (never retraced across jumps)
    const jumpQueue = []; // seed square ids scheduled by corner-jumps
    let foundFace = -1; // planeFaces index once a vertex is reached

    // Return the in-plane face cycle through corner (cu,cv), if it's a vertex.
    const faceAtCorner = (cu, cv) => faceAtVertex.get(`${cu},${cv}`);

    // INNER LOOP: bounded edge-adjacency flood-fill of ONE region from a seed.
    // Stops the whole search as soon as it reaches an in-plane skeleton VERTEX,
    // which pins the containing face — that's all the commit and visuals need.
    // Otherwise spreads across wall-free edges and SCHEDULES corner-jumps
    // (diagonals across NON-vertex corners, where the hop passes two walls at
    // once — legal — versus a vertex, where it would cross a single wall).
    const fillRegion = (seedId) => {
      const stack = [seedId];
      filled.add(seedId);
      while (stack.length) {
        const id = stack.pop();
        const [u, v] = uvOf.get(id);
        // A skeleton vertex at any of this square's 4 corners identifies the face.
        for (const [cu, cv] of [[u, v], [u + 1, v], [u, v + 1], [u + 1, v + 1]]) {
          const f = faceAtCorner(cu, cv);
          if (f !== undefined) {
            foundFace = f;
            return;
          }
        }
        for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nb = squareId.get(`${u + du},${v + dv}`);
          if (nb === undefined || filled.has(nb)) continue;
          if (sharedWall(u, v, du, dv)) continue;
          filled.add(nb);
          stack.push(nb);
        }
        for (const [du, dv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const cu = du === 1 ? u + 1 : u;
          const cv = dv === 1 ? v + 1 : v;
          if (planeVertices.has(`${cu},${cv}`)) continue; // never jump over a vertex
          const nb = squareId.get(`${u + du},${v + dv}`);
          if (nb !== undefined && !filled.has(nb)) jumpQueue.push(nb);
        }
      }
    };

    // OUTER LOOP: fill regions, draining scheduled corner-jumps, until a face is
    // identified. Case A (a region reaches a vertex) pins the face; case B (a
    // region exhausts as a rectangle without one — e.g. a crossing's arm) leads
    // to a corner-jump into the next region.
    fillRegion(startId);
    while (foundFace < 0 && jumpQueue.length) {
      const seed = jumpQueue.pop();
      if (!filled.has(seed)) fillRegion(seed);
    }

    if (foundFace < 0) return null; // no bounding face found (shouldn't happen)
    const { vertexIndices, segments } = planeFaces[foundFace];
    return { coord, vertexIndices, segments };
  }

  // Edit-axis integer values that hold NO boundary face orthogonal to the edit
  // axis (the drag's valid snap destinations). Always includes three planes
  // just beyond each extreme of the assembly on that axis, plus any interior
  // gaps. Excludes `excludeCoord` (the face's own current plane) so it isn't
  // offered as a destination.
  function computeAvailablePlanes(axis, excludeCoord) {
    const faces = boundaryFaceInfoByAxis[axis];
    const occupiedVals = new Set();
    let lo = Infinity;
    let hi = -Infinity;
    for (const f of faces) {
      const v = Math.round(f.center[axis]);
      occupiedVals.add(v);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 0;
    }

    const values = [];
    for (let v = lo - 3; v <= hi + 3; v++) {
      if (v === excludeCoord) continue;
      if (!occupiedVals.has(v)) values.push(v);
    }
    return values;
  }

  const occupied = new Map();
  const positions = [];

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

  // The autosave-to-localStorage path and the file-save paths share this
  // serializer, but the brink skeleton is included ONLY in saved files
  // (includeSkeleton = true) — never in the autosave, which stays lean and
  // always re-derives the skeleton from `positions` on load. The saved
  // skeleton is the concrete form { vertices, edges, faces }; the abstract
  // form (no coordinates) is derivable from it when needed.
  function currentStateJSON(includeSkeleton = false) {
    const state = {
      positions,
      faceVisibility,
      camera: {
        position: camera.position.toArray(),
        target: controls.target.toArray(),
      },
    };
    if (includeSkeleton) {
      state.skeleton = computeBrinkSkeleton(positions);
    }
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
    await writable.write(currentStateJSON(true));
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

    const blob = new Blob([currentStateJSON(true)], { type: 'application/json' });
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
    updateBrinkSkeleton();

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

  // Three load gestures over ONE file format, differing only in how the
  // cubes are derived:
  //   'cubes'    — take the file's positions directly (skeleton re-derived).
  //   'skeleton' — recover cubes from the file's concrete skeleton.
  //   'abstract' — discard the skeleton's coordinates, re-realize them, then
  //                recover cubes from the realized skeleton.
  // In every case the applied `positions` are the sole source of truth: the
  // app re-derives the brink skeleton from them on load (updateBrinkSkeleton
  // via addVoxel), so any loaded/realized skeleton is used only transiently
  // to compute the cubes and is then discarded. A round-trip where the
  // re-derived skeleton matches the loaded one is the built-in correctness
  // check.
  const dropOutOfBounds = (cubes) => {
    const kept = cubes.filter((c) => inBounds(c.x, c.y, c.z));
    if (kept.length !== cubes.length) {
      console.warn(`Load: ${cubes.length - kept.length} recovered cube(s) fell outside bounds and were dropped.`);
    }
    return kept;
  };

  // Synchronous cube derivation for the 'cubes' and 'skeleton' gestures (both
  // fast). The 'abstract' gesture is handled separately via a worker because
  // its coordinate realization can be slow — see realizeAbstract().
  function derivePositionsSync(state, interpretation) {
    if (interpretation === 'cubes') return state.positions;
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
    const MOVE_LABELS = ['Move Red', 'Move Yellow', 'Move Blue'];
    const label = moveAxis !== null ? MOVE_LABELS[moveAxis] : mode === 'build' ? 'Build' : 'Destroy';
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

  function updateBrinkSkeleton() {
    const skeleton = computeBrinkSkeleton(positions);
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

  function reset() {
    // Batch: raw removes/add, then one recompute/render. A per-cube
    // removeVoxel loop is O(N²) and rebuilds every InstancedMesh per cube,
    // which locks up on large models (e.g. a 37k-cube loaded skeleton).
    for (const { x, y, z } of [...positions]) removeVoxelRaw(x, y, z);
    addVoxelRaw(0, 0, 0);
    updateBrinkSkeleton();
    updateStatus(mode);
  }

  function addVoxel(x, y, z) {
    if (!inBounds(x, y, z) || hasVoxel(x, y, z)) return false;

    const idx = positions.length;
    const pos = { x, y, z };
    positions.push(pos);
    occupied.set(key(x, y, z), idx);

    updateBrinkSkeleton();
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
    updateBrinkSkeleton();
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
  if (saved?.positions?.length) {
    for (const { x, y, z } of saved.positions) addVoxelRaw(x, y, z);
  } else {
    addVoxelRaw(0, 0, 0);
  }
  updateBrinkSkeleton();

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  let mode = 'build';
  let downX = 0;
  let downY = 0;

  function setMode(nextMode) {
    mode = nextMode;
    setMoveAxis(null); // Build/Destroy and Move are mutually exclusive
    buildBtn.classList.toggle('active', mode === 'build');
    destroyBtn.classList.toggle('active', mode === 'destroy');
    updateStatus(mode);
  }

  function setMoveAxis(axis) {
    if (moveAxis === axis) return;
    cancelDrag();
    moveAxis = axis;
    for (let a = 0; a < 3; a++) moveBtns[a].classList.toggle('active', a === axis);
    // Rendering is decoupled from the move gesture: the render mode chosen via
    // the radios stays in effect whether or not a move axis is active, so we
    // neither override the rendering here nor disable the radios.
    if (axis === null) {
      hideAvailablePlanes();
    } else {
      // Leaving Build/Destroy: drop their active styling and status.
      buildBtn.classList.remove('active');
      destroyBtn.classList.remove('active');
      hoverOutline.visible = false;
      updateStatus(mode);
    }
  }

  function enterMoveMode(axis) {
    // Toggle off if the same axis button is clicked again.
    setMoveAxis(moveAxis === axis ? null : axis);
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

    if (moveAxis !== null) return; // move mode has its own drag interaction

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

  function startDrag(axis, hitId) {
    const face = connectedFace(axis, hitId);
    if (!face) return false;
    const values = computeAvailablePlanes(axis, face.coord);
    if (!values.length) return false;

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
      skeleton: currentSkeleton, // captured so face.vertexIndices stay valid
      planes: values,
      linePoint,
      dragValue: face.coord,
    };
    controls.enabled = false;
    showAvailablePlanes(axis, values, face.segments);
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

    // Move the dragged face to the target plane by shifting ONLY its skeleton
    // vertices' edit-axis coordinate, then recompute the whole cube array from
    // the modified skeleton — exactly the "load skeleton" path
    // (fillCubesFromSkeleton). Copy the captured skeleton so the live one isn't
    // mutated before the re-fill.
    const moved = new Set(face.vertexIndices);
    const vertices = skeleton.vertices.map((p, vi) => {
      if (!moved.has(vi)) return [p[0], p[1], p[2]];
      const q = [p[0], p[1], p[2]];
      q[axis] = plane;
      return q;
    });
    const modifiedSkeleton = { vertices, edges: skeleton.edges, faces: skeleton.faces };

    try {
      const cubes = dropOutOfBounds(fillCubesFromSkeleton(modifiedSkeleton));
      for (const { x, y, z } of [...positions]) removeVoxelRaw(x, y, z);
      for (const { x, y, z } of cubes) addVoxelRaw(x, y, z);
      updateBrinkSkeleton();
      updateStatus(mode);
    } catch (error) {
      console.error('Face drag failed while re-filling from skeleton:', error);
      updateBrinkSkeleton(); // resync render to the unchanged positions
    }
  }

  function endDrag() {
    drag = null;
    controls.enabled = true;
    hideDragIndicator();
    hideAvailablePlanes();
  }

  function cancelDrag() {
    if (drag) endDrag();
  }

  buildBtn.addEventListener('click', () => setMode('build'));
  destroyBtn.addEventListener('click', () => setMode('destroy'));
  resetBtn.addEventListener('click', () => reset());
  moveBtns.forEach((btn, axis) => btn.addEventListener('click', () => enterMoveMode(axis)));

  saveBtn.addEventListener('click', () => save());
  saveAsBtn.addEventListener('click', () => saveAs());
  loadBtn.addEventListener('click', () => load('cubes'));
  loadSkeletonBtn.addEventListener('click', () => load('skeleton'));
  loadAbstractBtn.addEventListener('click', () => load('abstract'));
  cancelBusyBtn.addEventListener('click', () => cancelRealization());

  renderer.domElement.addEventListener('pointerdown', (event) => {
    downX = event.clientX;
    downY = event.clientY;

    // In move mode, grabbing a rendered (edit-axis-normal) face starts a drag
    // and suspends the trackball so the camera doesn't rotate mid-drag.
    if (moveAxis !== null && !busy) {
      const hits = getIntersection(event.clientX, event.clientY, [cubeFaceMeshes[moveAxis]]);
      const hit = hits[0];
      if (hit && hit.instanceId !== undefined && hit.instanceId !== null) {
        if (startDrag(moveAxis, hit.instanceId)) {
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

    // Hover highlight: only over grabbable faces. In move mode that's the
    // edit-axis-normal mesh; otherwise any boundary face.
    const meshes = moveAxis !== null ? [cubeFaceMeshes[moveAxis]] : cubeFaceMeshes;
    const hits = getIntersection(event.clientX, event.clientY, meshes);
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
