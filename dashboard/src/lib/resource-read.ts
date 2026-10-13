/**
 * Throw-free reads of a Solid resource.
 *
 * In solid-js 1.9 BOTH `resource()` and `resource.latest` rethrow once a load
 * has failed and nothing is in flight — `latest` only returns the previous
 * value while a refetch is pending. A view that guards with `resource.latest`
 * therefore never reaches its own not-found / retry branch: the read throws
 * first and the error escapes to the nearest ErrorBoundary.
 */
import { type Accessor, createMemo, type Resource, untrack } from "solid-js";

/** `resource.latest`, but `undefined` exactly where `latest` would throw. */
export function latestOrUndefined<T>(resource: Resource<T>): T | undefined {
  if (resource.error !== undefined && !resource.loading) return undefined;
  return resource.latest;
}

/**
 * The loaded value of a supporting lookup (names for ids), or `undefined`
 * until it has loaded. Never suspends the page: reading `.latest` before the
 * first load registers with the shell's Suspense, which held whole screens
 * back on a list they only use to label rows.
 */
export function readyOrUndefined<T>(resource: Resource<T>): T | undefined {
  return resource.state === "ready"
    ? untrack(() => resource.latest)
    : undefined;
}

/**
 * The newest successfully loaded value, kept on screen when a later refetch
 * fails. `belongs` scopes every value to the entity the view currently shows:
 * while a different id loads, `latest` still holds the previous id's value,
 * and neither that nor a value kept after a failure may render (or drive
 * effects) under the new id. Pair it with `resource.error` for a quiet
 * "could not refresh" notice.
 */
export function createLastGoodValue<T>(
  resource: Resource<T>,
  belongs: (value: T) => boolean,
): Accessor<T | undefined> {
  return createMemo<T | undefined>((previous) => {
    const current = latestOrUndefined(resource);
    if (current !== undefined) return belongs(current) ? current : undefined;
    if (
      resource.error !== undefined &&
      previous !== undefined &&
      belongs(previous)
    ) {
      return previous;
    }
    return undefined;
  });
}
