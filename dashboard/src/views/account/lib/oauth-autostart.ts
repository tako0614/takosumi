/**
 * Single-provider sign-in auto-start breaker.
 *
 * When the operator configured exactly one sign-in method, /sign-in starts the
 * upstream OAuth round-trip on its own. Two things must be able to suppress
 * that:
 *
 *   1. A prior auto-start this browser session that never landed us signed in
 *      (OAuth failure, session cookie not persisted) — otherwise the bounce
 *      back to /sign-in re-fires it forever.
 *   2. An explicit sign-out. The upstream IdP session outlives our cookie, so
 *      an auto-start right after sign-out silently re-authenticates and the
 *      user never actually gets signed out.
 *
 * The flag lives in sessionStorage so it survives the full-page OAuth redirect
 * and dies with the tab. It sits in its own module because both `session.ts`
 * (sign-out) and the sign-in view need it, and `auth.ts` already imports the
 * HTTP layer that imports `session.ts`.
 */
const OAUTH_AUTOSTART_KEY = "takosumi.oauth-autostart-attempted";

export function autoStartAlreadyAttempted(): boolean {
  try {
    return sessionStorage.getItem(OAUTH_AUTOSTART_KEY) === "1";
  } catch {
    return false;
  }
}

export function markAutoStartAttempted(): void {
  try {
    sessionStorage.setItem(OAUTH_AUTOSTART_KEY, "1");
  } catch {
    // sessionStorage unavailable — `manual=1` on the sign-out / retry link is
    // the fallback suppression.
  }
}

export function clearAutoStartAttempt(): void {
  try {
    sessionStorage.removeItem(OAUTH_AUTOSTART_KEY);
  } catch {
    // ignore
  }
}
