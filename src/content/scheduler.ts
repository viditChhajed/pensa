/**
 * Frame-budget scheduler (plan §18C, T11).
 *
 * Detectors are generators; the scheduler drains them under `requestIdleCallback` with a
 * hard time slice, resuming mid-pass on the next idle window. Nothing here ever exceeds the
 * slice by more than one detector's runtime, which is why detectors must stay cheap.
 */
import { IDLE_SLICE_MS } from "@/shared/constants";

type IdleFn = (
  cb: (deadline: { timeRemaining(): number }) => void,
  opts?: { timeout: number },
) => number;

const requestIdle: IdleFn =
  typeof (globalThis as { requestIdleCallback?: IdleFn }).requestIdleCallback === "function"
    ? (globalThis as unknown as { requestIdleCallback: IdleFn }).requestIdleCallback.bind(
        globalThis,
      )
    : (cb) => setTimeout(() => cb({ timeRemaining: () => IDLE_SLICE_MS }), 1) as unknown as number;

/**
 * Drains `gen` across idle windows. Resolves when the generator finishes.
 * `onItem` runs synchronously inside the slice, so keep it cheap.
 */
export function drainAcrossIdle<T>(
  gen: Generator<T, void, unknown>,
  onItem: (item: T) => void,
  sliceMs = IDLE_SLICE_MS,
): Promise<void> {
  return new Promise((resolve) => {
    const step = (deadline: { timeRemaining(): number }): void => {
      const started = performance.now();
      while (
        performance.now() - started <
        Math.min(sliceMs, Math.max(1, deadline.timeRemaining()))
      ) {
        const next = gen.next();
        if (next.done) {
          resolve();
          return;
        }
        onItem(next.value);
      }
      requestIdle(step, { timeout: 250 });
    };
    requestIdle(step, { timeout: 250 });
  });
}
