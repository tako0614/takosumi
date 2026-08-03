/**
 * Tab-local consent for the one-action install / update auto-apply.
 *
 * `/runs/:id?auto=install` (and `?auto=update`) lets the run screen carry a
 * clean plan straight through to apply so the visitor never presses "deploy"
 * on a plan console. The query parameter alone is attacker-controllable: a
 * crafted link handed to a signed-in victim would apply a pending plan in
 * their workspace — real infrastructure, real spend — with no user action,
 * using the victim as a confused deputy (CWE-352).
 *
 * So the flag is not authority on its own. Every in-app entry into the auto
 * flow (the add flow's install, the app detail's 1-tap update, and the run
 * screen's own plan→apply and re-plan hops) mints a one-time token in
 * sessionStorage keyed to the run it is navigating to, and the run screen
 * requires BOTH the token and the parameter before it auto-applies. A link
 * opened anywhere else has no token, so the run screen falls through to the
 * ordinary console with its explicit deploy button.
 *
 * sessionStorage is same-origin and per-tab, and no query parameter can write
 * it — which is exactly the property `?auto` lacks.
 */

export type AutoApplyMode = "install" | "update";

const CONSENT_KEY_PREFIX = "takosumi.auto-apply-consent@";

/** Narrow a raw `?auto` query value to a mode this app actually offers. */
export function autoApplyModeFromParam(value: unknown): AutoApplyMode | null {
  return value === "install" || value === "update" ? value : null;
}

/**
 * Record that THIS tab started the `mode` flow for `runId`.
 *
 * Storage failures (private mode, storage disabled) are swallowed: the flow
 * then degrades to the explicit deploy button, never to an unauthorized apply.
 */
export function grantAutoApplyConsent(
  runId: string,
  mode: AutoApplyMode,
): void {
  if (!runId) return;
  try {
    sessionStorage.setItem(consentKey(runId), `${mode}:${mintToken()}`);
  } catch {
    /* no storage: the run screen shows the console instead */
  }
}

/** True when this tab minted the token for `runId` in `mode`. */
export function hasAutoApplyConsent(
  runId: string,
  mode: AutoApplyMode,
): boolean {
  if (!runId) return false;
  try {
    const stored = sessionStorage.getItem(consentKey(runId));
    const prefix = `${mode}:`;
    return (
      typeof stored === "string" &&
      stored.startsWith(prefix) &&
      stored.length > prefix.length
    );
  } catch {
    return false;
  }
}

/**
 * Build the `/runs/:id?auto=…` target AND mint its consent token together, so
 * no caller can navigate into the auto flow without recording that the user
 * started it here.
 */
export function autoApplyRunPath(
  path: string,
  runId: string,
  mode: AutoApplyMode,
): string {
  grantAutoApplyConsent(runId, mode);
  return `${path}${path.includes("?") ? "&" : "?"}auto=${mode}`;
}

function consentKey(runId: string): string {
  return `${CONSENT_KEY_PREFIX}${runId}`;
}

function mintToken(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}
