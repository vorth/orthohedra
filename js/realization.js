// --- Abstract realization worker ---------------------------------------
// The abstract gesture strips the skeleton's coordinates and re-realizes
// them, then fills cubes. Realization backtracks to find a valid slab
// ordering and can take seconds on large models, so it runs in a worker to
// keep the UI responsive; the worker can be terminated to cancel. NOTE:
// BEST-EFFORT — an abstract skeleton underdetermines geometry, so the
// recovered solid has a skeleton isomorphic to the input but may differ in
// shape/pose from the original.
//
// Exposed as a factory rather than loose functions because the "busy" flag has
// two readers with different needs: this module owns it, while main.js's edit
// and keyboard guards must observe it changing. A plain exported `let` would
// give importers a binding they cannot watch, so busy-ness is read through
// isBusy() instead.
//
// `busyOverlay` is injected rather than looked up here, so this module owns no
// DOM queries of its own.
export function createRealizer(busyOverlay) {
  let busy = false;
  let worker = null;
  let pendingReject = null; // reject fn of the in-flight realization, if any

  function setBusy(on) {
    busy = on;
    busyOverlay.hidden = !on;
  }

  function teardownWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    pendingReject = null;
  }

  function realizeAbstract(skeleton) {
    return new Promise((resolve, reject) => {
      // import.meta.url is THIS module's URL, so realizeWorker.js resolves as a
      // sibling of realization.js — the two must stay in the same directory.
      // (That is what kept this correct when the scripts moved into js/: they
      // moved together, so the sibling relationship never broke.)
      worker = new Worker(new URL('./realizeWorker.js', import.meta.url), { type: 'module' });
      pendingReject = reject;
      worker.onmessage = (event) => {
        const { cubes, error } = event.data;
        teardownWorker();
        if (error) reject(new Error(error));
        else resolve(cubes);
      };
      worker.onerror = (event) => {
        teardownWorker();
        reject(new Error(event.message || 'Realization worker failed'));
      };
      worker.postMessage({ skeleton });
    });
  }

  function cancelRealization() {
    if (pendingReject) {
      const reject = pendingReject;
      teardownWorker();
      reject(new Error('cancelled'));
    }
  }

  return { isBusy: () => busy, setBusy, realizeAbstract, cancelRealization };
}
