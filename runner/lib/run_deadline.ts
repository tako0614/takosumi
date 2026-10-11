// runner/lib/run_deadline.ts
//
// Whole-run execution budget for one runner request.
//
// A runner request is executed by commands that each carry their own profile
// timeout (`maxRunSeconds`), and every one of them starts after the host
// invocation that is waiting for the reply. On a host whose invocation has a
// hard wall-time limit (the Cloudflare composition runs the dispatch inside a
// Durable Object alarm), that per-command bound can never fire first: the host
// is cut off, the reply has no receiver, and an Apply ends indeterminate with
// its partial state lost. The Durable Object therefore forwards the time that
// is left as a relative budget, and every command spawned for the run stops
// before it runs out, so the runner's own definite timeout path wins.
//
// The budget rides on the run request's cancellation signal because that
// signal is the one per-run lifecycle object already threaded unchanged into
// every command context (source build, init, plan, apply, output). It is not
// part of the run request body, so it never enters mutation identity.

/** Private DO-to-container header: milliseconds left for this whole run. */
export const RUNNER_RUN_BUDGET_MS_HEADER = "x-takosumi-runner-budget-ms";

/** Largest budget the runner accepts; anything longer is no bound at all. */
const MAX_RUN_BUDGET_MS = 24 * 60 * 60 * 1000;

const runDeadlines = new WeakMap<AbortSignal, number>();

/**
 * Parses the forwarded budget. Only a plain non-negative decimal integer is a
 * budget; an absent or malformed header leaves the run unbounded exactly as
 * before the header existed.
 */
export function parseRunBudgetMs(value: string | null): number | undefined {
  if (value === null || !/^\d{1,9}$/u.test(value)) return undefined;
  const budget = Number(value);
  return Number.isSafeInteger(budget) && budget <= MAX_RUN_BUDGET_MS
    ? budget
    : undefined;
}

/**
 * Binds the forwarded budget to this run's signal, measured from now on the
 * runner's own monotonic clock (the sender's wall clock is never compared).
 */
export function registerRunBudget(
  signal: AbortSignal,
  header: string | null,
  now: number = performance.now(),
): void {
  const budget = parseRunBudgetMs(header);
  if (budget === undefined) return;
  runDeadlines.set(signal, now + budget);
}

/**
 * Milliseconds left before this run's deadline, or `undefined` when the run
 * has no deadline. Zero or less means the deadline has already passed.
 */
export function remainingRunBudgetMs(
  signal: AbortSignal | undefined,
  now: number = performance.now(),
): number | undefined {
  if (!signal) return undefined;
  const deadline = runDeadlines.get(signal);
  return deadline === undefined ? undefined : Math.floor(deadline - now);
}
