/**
 * How an app is FACED — the icon or, failing that, the initials.
 *
 * Three screens used to answer this separately (the launcher tile, the store
 * card, the add flow's header), with three different monogram rules: the same
 * `photo-blog` came out "PB" on the launcher and "PH" in the store, and only
 * the launcher fell back when the icon 404'd or kept the dashboard URL out of
 * the icon host's Referer. One rule, one fallback chain, one place.
 */
import { isUrlString } from "./capsules-ui.ts";

/**
 * Initials for an app with no icon. Word-aware first (`photo-blog` → PB) so
 * unrelated services do not collapse onto the same two letters; a single word
 * gives up its first two (`yurucommu` → YU) rather than one lonely letter.
 */
export function appMonogram(name: string): string {
  const trimmed = name.trim();
  const segments = trimmed.split(/[-_\s./]+/u).filter(Boolean);
  if (segments.length >= 2) {
    return (segments[0]![0]! + segments[1]![0]!).toUpperCase();
  }
  // Punctuation and separators are not initials: a name of only those has no
  // monogram at all, and "?" beats rendering "-" as the app's face.
  const compact = trimmed.replace(/[^\p{L}\p{N}]+/gu, "");
  return compact ? compact.slice(0, 2).toUpperCase() : "?";
}

/**
 * Split an Interface-declared `icon` into the two things it can actually be.
 * A path-style icon resolves against the app's own origin; anything path-ish
 * or URL-ish must never fall through to the emoji slot, or the tile paints
 * "/icons/app.svg" across its face.
 */
export function resolveAppIcon(
  icon: string | undefined,
  baseUrl?: string | undefined,
): { readonly imageSrc?: string; readonly emoji?: string } {
  if (!icon) return {};
  if (isUrlString(icon)) return { imageSrc: icon };
  if (/[./]/u.test(icon)) {
    if (!baseUrl) return {};
    try {
      return { imageSrc: new URL(icon, baseUrl).href };
    } catch {
      return {};
    }
  }
  return { emoji: icon };
}
