import {
  isSafeInstallVariableName,
  isSafeInstallVariableValue,
} from "../../lib/install-link.ts";
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
  if (listing.installConfigId) {
    params.set("installConfigId", listing.installConfigId);
    return params.toString();
  }
  if (listing.primaryServer) {
    params.set("tcsBase", listing.primaryServer);
    params.set("tcsListing", listing.id);
  }
  params.set("git", listing.source.git);
  if (listing.source.path) params.set("path", listing.source.path);
  params.set("name", listing.suggestedName.slice(0, 96));
  for (const input of listing.inputs) {
    if (!input.defaultValue) continue;
    if (!isSafeInstallVariableName(input.name)) continue;
    if (!isSafeInstallVariableValue(input.defaultValue)) continue;
    if (
      input.type === "boolean" ||
      input.type === "number" ||
      input.type === "json"
    ) {
      params.set(`varjson.${input.name}`, input.defaultValue);
    } else {
      params.set(`var.${input.name}`, input.defaultValue);
    }
  }
  return params.toString();
}

/** True when a listing needs config the quick-install path can't supply. */
export function needsConfiguration(listing: TcsListing): boolean {
  return listing.inputs.some((i) => i.required && !i.defaultValue);
}
