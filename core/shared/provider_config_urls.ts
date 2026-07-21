/**
 * Operator allowlist for absolute URLs inside provider configuration.
 *
 * A `providerConfig` map is rendered verbatim into the generated OpenTofu
 * provider block, so any `endpoint` / `base_url`-shaped string in it decides
 * which host the provider talks to — and therefore where the minted provider
 * credential is sent. Without an operator-owned allowlist a caller who can
 * write provider configuration can redirect provider traffic (and the
 * credential riding along with it) to a host of their choosing.
 *
 * The Resource Shape TargetPool surface has always run this check; the same
 * validator is shared so a ProviderConnection's `scopeHints.providerConfig`
 * cannot become the unguarded second entrance to the same generated block.
 */

/** Allowlist-comparable form: no query, no fragment, no trailing slashes. */
export function normalizeProviderConfigBaseUrl(value: string): string {
  const url = new URL(value.trim());
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/+$/u, "");
}

/**
 * Walks a JSON value and returns a message for the first absolute http(s) URL
 * that is not in the operator allowlist. Non-URL strings are untouched: only
 * values that can actually redirect provider traffic are policed.
 */
export function providerConfigUrlError(
  value: unknown,
  field: string,
  allowedUrls: ReadonlySet<string>,
): string | undefined {
  if (typeof value === "string") {
    if (!/^https?:\/\//iu.test(value)) {
      return undefined;
    }
    let normalized: string;
    try {
      normalized = normalizeProviderConfigBaseUrl(value);
    } catch {
      return `${field} contains an invalid absolute URL`;
    }
    return allowedUrls.has(normalized)
      ? undefined
      : `${field} URL ${normalized} is not in the operator allowlist`;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const error = providerConfigUrlError(
        item,
        `${field}[${index}]`,
        allowedUrls,
      );
      if (error) return error;
    }
  } else if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    for (const [key, item] of Object.entries(value)) {
      const error = providerConfigUrlError(
        item,
        `${field}.${key}`,
        allowedUrls,
      );
      if (error) return error;
    }
  }
  return undefined;
}
