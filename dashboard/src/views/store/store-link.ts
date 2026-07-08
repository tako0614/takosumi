import type { TcsListing } from "../../lib/tcs-client.ts";

/**
 * Build the `/new?…` query that pre-fills NewAppView for a listing — field-for-
 * field what `parseInstallPrefill` reads. Reuses the dashboard's own install-link
 * var guards so the produced query is guaranteed compatible. Store listings
 * only announce repository existence; Git ref/tag/commit selection remains on
 * the Source flow, so refs and resolved commits are intentionally not pinned
 * here even when a store node exposes them as display hints.
 */
export function buildNewQuery(listing: TcsListing): string {
  const params = new URLSearchParams();
  if (listing.primaryServer) {
    params.set("tcsBase", listing.primaryServer);
    params.set("tcsListing", listing.id);
  }
  params.set("git", listing.source.git);
  if (listing.source.path) params.set("path", listing.source.path);
  params.set("name", listing.suggestedName.slice(0, 96));
  return params.toString();
}
