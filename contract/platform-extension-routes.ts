/**
 * Route prefixes a platform extension may never claim.
 *
 * An extension host composes its descriptors in its own process, but the
 * Takosumi platform router is what parses them, and it rejects a reserved
 * basePath by throwing on every request. A host that cannot see this list
 * can only discover the collision by deploying, and only in the environments
 * where that extension happens to be configured. Publishing the list as
 * contract lets a host assert its own descriptors before shipping them.
 *
 * Deliberately narrower than all of `/v1`: operator extensions such as
 * `/v1/billing` and `/v1/cloud` are valid, while concrete Takosumi/Accounts
 * authorities are not.
 */
export const PLATFORM_EXTENSION_RESERVED_PREFIXES = [
  "/api",
  "/internal",
  "/__takosumi",
  "/.well-known",
  "/oauth",
  "/hooks",
  "/install",
  "/healthz",
  "/readyz",
  "/livez",
  "/metrics",
  "/capabilities",
  "/openapi.json",
  "/v1/account",
  "/v1/auth",
  "/v1/privacy",
  "/v1/capabilities",
  "/v1/form-availability",
  "/v1/offering-catalogs",
  "/v1/offering-availability",
  "/v1/offering-selections",
  "/v1/interfaces",
  "/v1/resources",
  "/v1/target-pools",
  "/v1/space-policies",
  "/apis/forms.takoform.com/v1alpha1",
] as const;

export function pathIsUnderBase(pathname: string, basePath: string): boolean {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

export function platformExtensionBasePathIsReserved(basePath: string): boolean {
  return PLATFORM_EXTENSION_RESERVED_PREFIXES.some(
    (prefix) =>
      pathIsUnderBase(basePath, prefix) || pathIsUnderBase(prefix, basePath),
  );
}
