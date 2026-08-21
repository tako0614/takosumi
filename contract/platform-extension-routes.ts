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
 * The retired `/v1` namespace is reserved wholesale and cannot be reclaimed
 * by an extension. Optional features are allowlisted at their exact
 * `/api/v1/...` roots; currently billing and Hosted subscription are the only
 * such roots. Concrete Takosumi/Accounts authorities are not delegated.
 * The `/.well-known` namespace is handled separately:
 * the root, the two core leaves, and the retired Takoform v1alpha1/v1alpha2/
 * v1alpha3 leaves stay reserved, while an explicitly exact descriptor may
 * claim an unknown sibling without claiming the namespace.
 */
export const PLATFORM_EXTENSION_RESERVED_PREFIXES = [
  "/api",
  "/internal",
  "/__takosumi",
  "/oauth",
  "/hooks",
  "/install",
  "/healthz",
  "/readyz",
  "/livez",
  "/metrics",
  "/capabilities",
  "/openapi.json",
  // The former public JSON namespace is retired wholesale. Keeping this as a
  // single prefix prevents an unlisted legacy sibling from becoming an
  // extension compatibility alias.
  "/v1",
  "/api/v1/account",
  "/api/v1/auth",
  "/api/v1/privacy",
  // Retired Accounts identity paths remain unavailable to extensions; they
  // must reach the Accounts handler's JSON 404 rather than be reclaimed.
  "/api/v1/capabilities",
  "/api/v1/interfaces",
  "/apis/forms.takoform.com/v1alpha1",
  "/apis/forms.takoform.com/v1alpha2",
  "/apis/forms.takoform.com/v1alpha3",
] as const;

/** Exact optional extension roots permitted inside the otherwise reserved `/api`. */
export const PLATFORM_EXTENSION_ALLOWLISTED_BASE_PATHS = [
  "/api/v1/billing",
  "/api/v1/hosted/subscription",
] as const;

/** Exact well-known routes owned by Takosumi/Accounts or held unavailable. */
export const PLATFORM_EXTENSION_RESERVED_EXACT_PATHS = [
  "/.well-known",
  "/.well-known/openid-configuration",
  "/.well-known/takosumi",
  // The retired Takoform Host namespace root itself cannot be reclaimed. It
  // remains a parent for exact external leaves such as the current Beta path.
  "/.well-known/takoform",
  // Retired candidate Host discovery leaves must not be re-mounted or
  // advertised by the generic Takosumi extension seam. The current external
  // Beta identity is intentionally not listed and remains exact-configurable.
  "/.well-known/takoform/v1alpha1",
  "/.well-known/takoform/v1alpha2",
  "/.well-known/takoform/v1alpha3",
] as const;

/** External-standard namespaces where only explicit exact leaves may mount. */
export const PLATFORM_EXTENSION_EXACT_LEAF_PARENT_PREFIXES = [
  "/.well-known",
  "/.well-known/takoform",
] as const;

export type PlatformExtensionMatchMode = "subtree" | "exact";

export function pathIsUnderBase(pathname: string, basePath: string): boolean {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

/**
 * Whether a descriptor basePath would claim a Takosumi-owned route.
 *
 * The existing descriptor mode is a subtree claim. Exact descriptors are the
 * only escape hatch under an external-standard parent such as `/.well-known`:
 * they claim one canonical leaf and cannot shadow a reserved leaf or its
 * descendants. A subtree descriptor still cannot claim any ancestor or child
 * of a reserved route.
 */
export function platformExtensionBasePathIsReserved(
  basePath: string,
  matchMode: PlatformExtensionMatchMode = "subtree",
): boolean {
  if (
    (PLATFORM_EXTENSION_ALLOWLISTED_BASE_PATHS as readonly string[]).includes(
      basePath,
    )
  ) {
    return false;
  }
  if (
    PLATFORM_EXTENSION_RESERVED_PREFIXES.some(
      (prefix) =>
        pathIsUnderBase(basePath, prefix) || pathIsUnderBase(prefix, basePath),
    )
  ) {
    return true;
  }

  for (const exactPath of PLATFORM_EXTENSION_RESERVED_EXACT_PATHS) {
    const isExactLeafParent = (
      PLATFORM_EXTENSION_EXACT_LEAF_PARENT_PREFIXES as readonly string[]
    ).includes(exactPath);
    if (basePath === exactPath) {
      return true;
    }
    if (
      pathIsUnderBase(basePath, exactPath) &&
      (!isExactLeafParent || matchMode === "subtree")
    ) {
      return true;
    }
    if (
      matchMode === "subtree" && pathIsUnderBase(exactPath, basePath)
    ) {
      return true;
    }
  }

  return false;
}

/** Match one request path using the descriptor's declared route mode. */
export function platformExtensionRouteMatchesPath(
  pathname: string,
  basePath: string,
  matchMode: PlatformExtensionMatchMode = "subtree",
): boolean {
  return matchMode === "exact"
    ? pathname === basePath
    : pathIsUnderBase(pathname, basePath);
}
