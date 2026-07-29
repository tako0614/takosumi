/**
 * Private in-process headers used only after platform ingress has verified an
 * existing managed-provider run token. Public ingress strips caller-supplied
 * values before conditionally forwarding the verified token and its exact
 * profile to deploy-control.
 *
 * The token remains the sole authority. Core verifies its HMAC, audience,
 * Workspace, scopes, and durable Capsule installer provenance again before
 * assigning Capsule ownership; these headers never form a second credential.
 */
export const TAKOSUMI_INTERNAL_MANAGED_PROVIDER_RUN_TOKEN_HEADER =
  "x-takosumi-internal-managed-provider-run-token";

export const TAKOSUMI_INTERNAL_MANAGED_PROVIDER_PROFILE_HEADER =
  "x-takosumi-internal-managed-provider-profile";
