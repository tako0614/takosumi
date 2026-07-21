/**
 * Same-tab provenance token for the store's one-tap install.
 *
 * `/new?auto=1` starts the single install action with no further click, so the
 * URL alone must never be the authority for it: every param the previous gate
 * relied on (`auto`, `tcsBase`, `tcsListing`, `git`) is attacker-writable, so a
 * link from any site could register a Source, create a Capsule and start a plan
 * in the visitor's workspace with no interaction. A same-site cookie does not
 * help — this is a top-level navigation, after which every control call is
 * same-origin.
 *
 * The in-app store CTA therefore mints a one-shot token in sessionStorage and
 * puts only its id in the query. A cross-origin page cannot write that entry,
 * and consuming it deletes it, so Back or a re-shared URL cannot replay the
 * install either.
 */
const AUTO_INSTALL_TOKEN_KEY_PREFIX = "takosumi.auto-install.";

/** Query parameter carrying the token id (never the token's authority). */
export const AUTO_INSTALL_TOKEN_PARAM = "autoToken";

/**
 * Arm a one-tap install for the navigation this call is about to make. Returns
 * the id to put in the `/new` query, or undefined when sessionStorage is
 * unavailable — in which case the target lands as an ordinary pre-fill and the
 * user presses Add, which is the safe outcome.
 */
export function issueAutoInstallToken(): string | undefined {
  try {
    const id = crypto.randomUUID();
    sessionStorage.setItem(`${AUTO_INSTALL_TOKEN_KEY_PREFIX}${id}`, "1");
    return id;
  } catch {
    return undefined;
  }
}

/**
 * One-shot check that this `/new` visit really came from our own store CTA in
 * this tab. Always consumes the token, so a replay of the same URL is rejected.
 */
export function consumeAutoInstallToken(search: string): boolean {
  const id = new URLSearchParams(
    search.startsWith("?") ? search : `?${search}`,
  ).get(AUTO_INSTALL_TOKEN_PARAM);
  if (!id) return false;
  const key = `${AUTO_INSTALL_TOKEN_KEY_PREFIX}${id}`;
  try {
    const armed = sessionStorage.getItem(key) === "1";
    sessionStorage.removeItem(key);
    return armed;
  } catch {
    return false;
  }
}
