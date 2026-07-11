/**
 * One small primitive for the account screens' hand-rolled async-action
 * machine.
 *
 * Almost every mutation path was the same shape: a `busy` signal, an `error`
 * signal, an optional `result` signal, and a `setBusy(true) / setError(null) /
 * try { ... } catch { setError(msg) } finally { setBusy(false) }` block, with
 * `(e as ApiError).message` copied inline ~a dozen times. {@link createAction}
 * captures that shape so the call sites only describe the async work + its
 * success side effects.
 *
 * Behavior is identical to the inline version:
 *   - `run()` sets `busy` true, clears `error`, awaits `fn`, stores the
 *     resolved value in `result`, and returns it; on throw it records the
 *     message in `error` (and rethrows nothing — `run` resolves to
 *     `undefined`). `busy` is always cleared in `finally`.
 *   - the success side effects (refetch / navigate / reset inputs) live in
 *     `fn` itself, after the awaited call, so they only run on success.
 *
 * Ported from takosumi dashboard-ui/src/lib/action.tsx.
 */
import { type Accessor, createSignal, type JSX, Show } from "solid-js";
import { friendlyError } from "../../../lib/error-copy.ts";
import { t } from "../../../i18n/index.ts";

/**
 * Extract a SAFE, localized user-facing message from a thrown value.
 *
 * Routes through {@link friendlyError} so raw HTTP/server internals (a bare
 * `500 Internal Server Error` status line, opaque server sentences) never reach
 * the account screens; genuine user-facing messages pass through unchanged.
 */
export function errorMessage(e: unknown): string {
  return friendlyError(e, t).message;
}

export interface Action<Args extends unknown[], Result> {
  /** Run the action; resolves to the result on success, `undefined` on error. */
  readonly run: (...args: Args) => Promise<Result | undefined>;
  readonly busy: Accessor<boolean>;
  readonly error: Accessor<string | null>;
  /**
   * Raw error text behind a sanitized {@link error} message, for an optional
   * folded/tooltip disclosure. `null` when the surfaced error is already the
   * full user-facing message (client-side validation) or when there is none.
   */
  readonly errorDetail: Accessor<string | null>;
  readonly result: Accessor<Result | undefined>;
  /**
   * Surface a message on the action's error signal without running `fn` —
   * for client-side pre-flight validation that shares the same error display.
   */
  readonly setError: (message: string | null) => void;
  /** Imperatively clear the surfaced error (e.g. when re-opening a form). */
  readonly clearError: () => void;
  /** Imperatively reset the stored result. */
  readonly clearResult: () => void;
}

export function createAction<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>,
): Action<Args, Result> {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [errorDetail, setErrorDetail] = createSignal<string | null>(null);
  const [result, setResult] = createSignal<Result | undefined>(undefined);

  const run = async (...args: Args): Promise<Result | undefined> => {
    setBusy(true);
    setError(null);
    setErrorDetail(null);
    try {
      const r = await fn(...args);
      setResult(() => r);
      return r;
    } catch (e) {
      const friendly = friendlyError(e, t);
      setError(friendly.message);
      setErrorDetail(friendly.detail ?? null);
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  return {
    run,
    busy,
    error,
    errorDetail,
    result,
    // Client-side validation messages are already the full user-facing text, so
    // clear any lingering raw detail from a prior failed run.
    setError: (message) => {
      setError(message);
      setErrorDetail(null);
    },
    clearError: () => {
      setError(null);
      setErrorDetail(null);
    },
    clearResult: () => setResult(() => undefined),
  };
}

/**
 * Render an action's surfaced error with the shared `.sign-in-error` style.
 *
 * Pass `detail` (e.g. `action.errorDetail`) to attach the raw error text as a
 * native tooltip without exposing it in the visible copy.
 */
export function ActionError(props: {
  error: Accessor<string | null>;
  detail?: Accessor<string | null>;
}): JSX.Element {
  return (
    <Show when={props.error()}>
      {(m) => (
        <p
          class="sign-in-error"
          role="alert"
          title={props.detail?.() ?? undefined}
        >
          {m()}
        </p>
      )}
    </Show>
  );
}
