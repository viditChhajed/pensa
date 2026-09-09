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
 *
 * Resolves with the CPU time actually consumed — the sum of the slices, excluding the
 * waiting between them.
 *
 * That distinction is not bookkeeping. The caller sizes its backoff from this number, and
 * it used to use wall-clock, which on a busy page is dominated by how long the browser took
 * to hand out an idle window (up to the 250ms timeout, per slice). Measured on target.com:
 * 1255ms wall-clock for 344ms of work. The duty-cycle limiter then multiplied that idle
 * waiting by ten and backed off for twelve seconds — so the extension penalised itself for
 * yielding politely, and the harder it tried not to block the page, the blinder it became.
 * A duty cycle is a share of the main thread; time spent not on the main thread is not part
 * of it.
 */
export function drainAcrossIdle<T>(
  gen: Generator<T, void, unknown>,
  onItem: (item: T) => void,
  sliceMs = IDLE_SLICE_MS,
): Promise<number> {
  return new Promise((resolve) => {
    let cpuMs = 0;
    const step = (deadline: { timeRemaining(): number }): void => {
      const started = performance.now();
      const budget = Math.min(sliceMs, Math.max(1, deadline.timeRemaining()));
      while (performance.now() - started < budget) {
        const next = gen.next();
        if (next.done) {
          cpuMs += performance.now() - started;
          resolve(cpuMs);
          return;
        }
        onItem(next.value);
      }
      cpuMs += performance.now() - started;
      requestIdle(step, { timeout: 250 });
    };
    requestIdle(step, { timeout: 250 });
  });
}
