import { isCanonicalRepositoryDirectoryPath } from "takosumi-contract";
import type { TcsListing } from "../../lib/tcs-client.ts";

/**
 * Build the `/new?…` query that pre-fills InstallView for a listing — field-for-
 * field what `parseInstallPrefill` reads. Reuses the dashboard's own install-link
 * var guards so the produced query is guaranteed compatible.
 *
 * The listing's reviewed module travels as `path`. It is only a hint: the
 * installer proves it against the snapshot scan it runs from the immutable
 * Source and asks the user when the scan cannot, so a catalog entry can never
 * install a module the repository does not expose. Refs, tags, commits, and
 * setup values stay on the Source/compatibility flow.
 */
export function buildNewQuery(listing: TcsListing): string {
  const params = new URLSearchParams();
  if (listing.primaryServer) {
    params.set("tcsBase", listing.primaryServer);
    params.set("tcsListing", listing.id);
  }
  params.set("git", listing.source.url);
  // Reuse the install-link guard so a hand-built listing can never smuggle a
  // non-canonical directory into the prefill.
  if (
    listing.source.path &&
    isCanonicalRepositoryDirectoryPath(listing.source.path)
  ) {
    params.set("path", listing.source.path);
  }
  params.set("name", listing.suggestedName.slice(0, 96));
  return params.toString();
}
