// Web Worker: realizes an abstract brink skeleton and fills its cubes off the
// UI thread. The seriation in realizeAbstractSkeleton can spike to seconds on
// larger models, so this keeps the editor responsive; the main thread can
// terminate this worker to cancel a long-running realization.
//
// Loaded as a module worker (new Worker(url, { type: 'module' })) so it can
// import the same zero-build ES modules the app uses.

import { realizeAbstractSkeleton, toAbstractSkeleton, fillCubesFromSkeleton } from './realizeSkeleton.js';

self.onmessage = (event) => {
  const { skeleton } = event.data;
  try {
    const concrete = realizeAbstractSkeleton(toAbstractSkeleton(skeleton));
    const cubes = fillCubesFromSkeleton(concrete);
    self.postMessage({ cubes });
  } catch (error) {
    self.postMessage({ error: error?.message || String(error) });
  }
};
