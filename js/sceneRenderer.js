// Everything that draws: the three.js scene, camera, controls and lights, the
// InstancedMeshes backing cubes / skeleton / drag visuals, and the functions
// that push model data into them.
//
// The dependency runs ONE WAY. This module is a SINK: it takes plain data
// (cube positions, a skeleton, in-plane segments) and puts pixels on screen. It
// never reads the voxel set, the history, or the drag state, and it calls
// nothing in main.js — the single outward call that used to exist
// (cycleFaceVisibility triggering an autosave) is now an `onFaceVisibilityChange`
// callback the caller supplies.
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

// `onFaceVisibilityChange` is called after a visibility cycle so the caller can
// persist the new view state.
// Initial per-mesh instance capacity; ensureInstanceCapacity() grows it (to the
// next power of two) whenever a render needs more. Deliberately small: the
// number of boundary faces and skeleton elements is bounded by the cubes
// actually placed (a surface-area quantity), never by the world volume.
const INITIAL_INSTANCES = 4096;

export function createSceneRenderer(app, { onFaceVisibilityChange } = {}) {
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
    onFaceVisibilityChange?.();
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
  const getCameraState = () => ({
    position: camera.position.toArray(),
    target: controls.target.toArray(),
  });

  function setCameraState({ position, target }) {
    camera.position.fromArray(position);
    controls.target.fromArray(target);
    controls.update();
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

  const onCameraChange = (fn) => controls.addEventListener('change', fn);

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
    // camera / viewport / loop
    getCameraState,
    setCameraState,
    setControlsEnabled,
    onCameraChange,
    handleResize,
    start,
  };
}
