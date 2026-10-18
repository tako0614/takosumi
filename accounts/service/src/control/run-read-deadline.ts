import { withPrivateNoStoreHeaders } from "../http-helpers.ts";
import { controlPlaneUnavailable } from "./shared.ts";

const RUN_GET_READ_DEADLINE_MS = 5_000;

export type RunReadWaiter = (
  operation: (assertActive: () => void) => Promise<Response>,
) => Promise<Response>;

/** One outer request and its Run projection share one timer and active guard. */
export function runGetWithinDeadline(
  operation: (assertActive: () => void, wait: RunReadWaiter) => Promise<Response>,
): Promise<Response> {
  let timedOut = false;
  const waiters = new Set<() => void>();
  const unavailable = () => withPrivateNoStoreHeaders(controlPlaneUnavailable());
  const assertActive = (): void => {
    if (timedOut) throw new Error("run_get_read_deadline_expired");
  };
  const timer = setTimeout(() => {
    timedOut = true;
    // Let an entered Run projection unwind through its diagnostic spans before
    // the outer HTTP response settles. Before dispatch, only the outer waiter
    // exists. Neither path starts a second timer or resets the request budget.
    [...waiters].at(-1)?.();
  }, RUN_GET_READ_DEADLINE_MS);
  const wait: RunReadWaiter = (work) => {
    if (timedOut) return Promise.resolve(unavailable());
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const expire = () => {
        if (settled) return;
        settled = true;
        waiters.delete(expire);
        resolve(unavailable());
      };
      waiters.add(expire);
      let pending: Promise<Response>;
      try {
        assertActive();
        pending = Promise.resolve(work(assertActive));
      } catch (error) {
        pending = Promise.reject(error);
      }
      void pending.then(
        (response) => {
          if (settled) return;
          settled = true;
          waiters.delete(expire);
          resolve(response);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          waiters.delete(expire);
          reject(error);
        },
      );
    });
  };
  return wait((guard) => operation(guard, wait)).finally(() => clearTimeout(timer));
}
