import {
  isSafeInstallVariableName,
  isSafeInstallVariableValue,
} from "../../lib/install-link.ts";
import type { TcsListing } from "../../lib/tcs-client.ts";

/**
 * Build the `/new?…` query that pre-fills NewAppView for a listing — field-for-
 * field what `parseInstallPrefill` reads. Reuses the dashboard's own install-link
 * var guards so the produced query is guaranteed compatible. Pins to the resolved
 * commit when known (commit-pin).
 */
export function buildNewQuery(listing: TcsListing): string {
  const params = new URLSearchParams();
  params.set("git", listing.source.git);
  params.set("ref", listing.source.resolvedCommit ?? listing.source.ref);
  if (listing.source.path) params.set("path", listing.source.path);
  params.set("name", listing.suggestedName.slice(0, 96));
  for (const input of listing.inputs) {
    if (!input.defaultValue) continue;
    if (!isSafeInstallVariableName(input.name)) continue;
    if (!isSafeInstallVariableValue(input.defaultValue)) continue;
    params.set(`var.${input.name}`, input.defaultValue);
  }
  return params.toString();
}

/** True when a listing needs config the quick-install path can't supply. */
export function needsConfiguration(listing: TcsListing): boolean {
  return listing.inputs.some((i) => i.required && !i.defaultValue);
}
