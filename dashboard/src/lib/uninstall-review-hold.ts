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

type Hold = {
  readonly release: () => void;
  readonly recordReservation: (id: unknown) => void;
};

const noHold: Hold = { release: () => {}, recordReservation: () => {} };

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

function markerOwner(marker: string | undefined | null): string | undefined {
  return marker?.split(":", 1)[0];
}

function currentMarker(key: string, stored = storedHold(key)): string | undefined {
  const memory = holds.get(key);
  // If storage could not be updated, keep the in-memory extension of its token.
  return !stored || memory?.startsWith(`${stored}:`) ? memory : stored;
}

function writeMarker(key: string, marker: string): void {
  holds.set(key, marker);
  try {
    window.sessionStorage.setItem(key, marker);
  } catch {
    // The active document still has the marker.
  }
}

function validReservation(id: unknown, oldPlanId: string): id is string {
  return typeof id === "string" && id !== oldPlanId && id.length <= 256 &&
    /^plan_[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id);
}

export function reservedUninstallReview(scope: Scope): { token: string; planRunId: string } | undefined {
  const key = holdKey(scope);
  if (!key) return;
  const marker = currentMarker(key);
  if (!marker) return;
  // A legacy marker is just the token. The reservation suffix shares its owner.
  const [token, planRunId] = marker.split(":");
  if (token && validReservation(planRunId, scope[4]) && marker === `${token}:${planRunId}`) return { token, planRunId };
}

/** Only the request that created a marker can release the value it wrote. */
export function holdUninstallReview(scope: Scope): Hold {
  const key = holdKey(scope);
  if (!key) return noHold;
  const previous = currentMarker(key);
  const token = previous ?? randomUuid();
  let ownedMarker = previous ? undefined : token;
  if (!previous) writeMarker(key, token);
  return {
    recordReservation(id) {
      // A later explicit request may fill the empty marker it saw at dispatch.
      // It cannot replace an existing reservation or acquire release authority.
      if (!validReservation(id, scope[4]) || markerOwner(token) !== token || currentMarker(key) !== token) return;
      const marker = `${token}:${id}`;
      if (ownedMarker) ownedMarker = marker;
      writeMarker(key, marker);
    },
    release() {
      if (!ownedMarker) return;
      const stored = storedHold(key);
      const ownsCurrent = currentMarker(key, stored) === ownedMarker;
      if (holds.get(key) === ownedMarker) holds.delete(key);
      try {
        if (ownsCurrent && markerOwner(stored) === token) window.sessionStorage.removeItem(key);
      } catch {
        // The browser may disable storage while the request is in flight.
      }
    },
  };
}
