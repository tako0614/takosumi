import { randomUuid } from "./random-uuid.ts";

type Scope = readonly [
  principalId: string | undefined,
  accountId: string | undefined,
  workspaceId: string | undefined,
  capsuleId: string | undefined,
  planRunId: string,
];

// The in-memory copy still protects navigation when the browser denies storage.
const holds = new Map<string, string>();

function holdKey(scope: Scope): string | undefined {
  return scope.every(Boolean) ? `takosumi.uninstall-review-hold:${JSON.stringify(scope)}` : undefined;
}

function storedHold(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function isUninstallReviewHeld(scope: Scope): boolean {
  const key = holdKey(scope);
  return Boolean(key && (holds.has(key) || storedHold(key)));
}

/** Returns a release for this request's marker only. Earlier holds are retained. */
export function holdUninstallReview(scope: Scope): () => void {
  const key = holdKey(scope);
  if (!key || holds.has(key) || storedHold(key)) return () => {};
  const token = randomUuid();
  holds.set(key, token);
  try {
    window.sessionStorage.setItem(key, token);
  } catch {
    // The active document still has the marker.
  }
  return () => {
    if (holds.get(key) === token) holds.delete(key);
    try {
      if (storedHold(key) === token) window.sessionStorage.removeItem(key);
    } catch {
      // The browser may disable storage while the request is in flight.
    }
  };
}
