import {
  appendTakosumiAppHandoff,
  createTakosumiAppConnectHref,
  createTakosumiAppHandoffUrl,
  isSafeLinkHref,
  parseTakosumiAppInstallScheme,
  takosumiAppHandoffFromSearch,
  takosumiAppProductLabel,
  type TakosumiAppHandoff,
} from "takosumi-contract";

export { createTakosumiAppHandoffUrl, parseTakosumiAppInstallScheme };

export type { TakosumiAppHandoff as AppHandoff } from "takosumi-contract";
export type { TakosumiAppInstallSchemeFields } from "takosumi-contract";

export function appHandoffFromSearch(
  search: string,
): TakosumiAppHandoff | undefined {
  return takosumiAppHandoffFromSearch(search);
}

export function appendAppHandoff(
  path: string | undefined,
  handoff: TakosumiAppHandoff | undefined,
): string | undefined {
  return appendTakosumiAppHandoff(path, handoff);
}

export function createAppHandoffConnectHref(
  handoff: TakosumiAppHandoff | undefined,
  hostUrl: string | undefined,
): string | undefined {
  if (!handoff || !hostUrl) return undefined;
  const href = createTakosumiAppConnectHref({ handoff, hostUrl });
  // The connect href is built from the `return_uri` query parameter, and the
  // run screen renders it as a clickable anchor. Re-check the scheme at the
  // render boundary so a script-capable URI can never reach an href even if it
  // slipped past the parser.
  return href !== undefined && isSafeLinkHref(href) ? href : undefined;
}

export function appHandoffProductLabel(product: string): string {
  return takosumiAppProductLabel(product);
}

/**
 * Redirect target for a `web+takosumi:install?…` protocol payload delivered as
 * `/install?handoff=<…>`. Builds a FRESH `/new` query from only the decoded,
 * whitelisted scheme fields — every other outer param is discarded, so a
 * hand-crafted `/install?handoff=<benign>&auto=1&tcsBase=…&tcsListing=…` link
 * cannot smuggle the auto-install trigger past the prefill-only gate. Capsule-
 * only: no `kind`, so it always lands on `/new`. Invalid payloads fall back to a
 * bare `/new`. Spec: docs/integration/remote-install.md.
 */
export function installHandoffTarget(handoff: string): string {
  const fields = parseTakosumiAppInstallScheme(handoff);
  if (!fields) return "/new";
  const fresh = new URLSearchParams();
  if (fields.git) fresh.set("git", fields.git);
  if (fields.source) fresh.set("source", fields.source);
  if (fields.ref) fresh.set("ref", fields.ref);
  if (fields.path) fresh.set("path", fields.path);
  if (fields.name) fresh.set("name", fields.name);
  if (fields.product) fresh.set("product", fields.product);
  if (fields.returnUri) fresh.set("return_uri", fields.returnUri);
  const query = fresh.toString();
  return query ? `/new?${query}` : "/new";
}
