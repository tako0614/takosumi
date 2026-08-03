import type { TcsListing } from "../../lib/tcs-client.ts";

/**
 * Build the `/new?…` query that pre-fills NewAppView for a listing — field-for-
 * field what `parseInstallPrefill` reads. Reuses the dashboard's own install-link
 * var guards so the produced query is guaranteed compatible. Store listings
 * only announce repository existence; ref/tag/commit and module-path selection
 * remain on the Source/compatibility flow, so no listing path or ref is handed
 * to the installer here.
 */
export function buildNewQuery(listing: TcsListing): string {
  const params = new URLSearchParams();
  if (listing.primaryServer) {
    params.set("tcsBase", listing.primaryServer);
    params.set("tcsListing", listing.id);
  }
  params.set("git", listing.source.url);
  params.set("name", listing.suggestedName.slice(0, 96));
  return params.toString();
}
