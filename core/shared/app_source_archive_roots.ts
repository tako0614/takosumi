/**
 * Internal Runner capability (TASK-0118 P9.1-f): the Runner image accepts a
 * Source archive key under an app's `apps/{capsuleId}/sources/…` root. A Worker
 * allocates such keys only after its Runner advertised this on `/healthz`;
 * an older image refuses them. Never a public Host or Takoform contract.
 */
export const APP_SOURCE_ARCHIVE_ROOTS_CAPABILITY =
  "takosumi.app-source-archive-roots@v1";

/**
 * Caches a Runner capability probe for one process or isolate. A confirmed
 * capability is kept (the image does not change without a deploy, which
 * replaces the process); a refusal or failure is retried after `retryMs`.
 * Concurrent callers share one probe. The probe never throws to the caller.
 */
export function cachedRunnerCapabilityProbe(
  probe: () => Promise<boolean>,
  options: { readonly retryMs?: number; readonly now?: () => number } = {},
): () => Promise<boolean> {
  const retryMs = options.retryMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  let confirmed = false;
  let refusedAt: number | undefined;
  let inFlight: Promise<boolean> | undefined;
  return async () => {
    if (confirmed) return true;
    if (refusedAt !== undefined && now() - refusedAt < retryMs) return false;
    inFlight ??= (async () => {
      let accepted = false;
      try { accepted = await probe() === true; } catch { accepted = false; }
      if (accepted) confirmed = true;
      else refusedAt = now();
      return accepted;
    })().finally(() => { inFlight = undefined; });
    return await inFlight;
  };
}
