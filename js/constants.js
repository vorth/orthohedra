// Values shared across modules. Rendering-internal numbers (mesh radii,
// linewidths, material colors) deliberately stay in main.js for now: they
// belong with the renderer when it is extracted, not here.

// SIZE is only the coordinate bound of the editable region (used by inBounds,
// the grid helper, and the world box). It deliberately does NOT size any GPU
// buffer: the number of boundary faces and skeleton elements is bounded by the
// cubes actually placed (a surface-area quantity), never by SIZE³, so the
// InstancedMeshes start small and grow on demand instead of preallocating
// SIZE³ instances (which was ~3.2 GB of matrix buffers at SIZE=170).
export const SIZE = 170;
export const HALF = Math.floor(SIZE / 2);
export const MIN = -HALF;
export const MAX = HALF;

// Per-axis colors, shared by the skeleton edges, the small boundary-cube
// faces, and the giant boundary cube: X red, Y yellow, Z blue.
export const AXIS_COLORS = [0xff3b30, 0xffd60a, 0x0a84ff];
// The same colors lightened ~30% toward white, used to tint the quad faces
// so they read as a softer shade of their normal-axis color.
export const FACE_COLORS = [0xff766e, 0xffe254, 0x53a9ff];

// Per-axis face visibility, a tri-state cycled by clicking the giant boundary
// cube's faces: SOLID -> TRANSLUCENT -> HIDDEN -> SOLID.
export const FACE_SOLID = 2;
export const FACE_TRANSLUCENT = 1;
export const FACE_HIDDEN = 0;

export const STORAGE_KEY = 'cubes-editor:state';

// Is this lattice point inside the editable region? Shared by the voxel
// primitives, the load path's coordinate validation, and out-of-bounds culling.
export function inBounds(x, y, z) {
  return x >= MIN && x <= MAX && y >= MIN && y <= MAX && z >= MIN && z <= MAX;
}
