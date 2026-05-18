import type { Shape } from "takosumi-contract";
import {
  isNonEmptyString,
  requireNonEmptyString,
  requireRoot,
} from "./_validators.ts";
import {
  OIDC_CAPABILITIES,
  OIDC_DESCRIPTION,
  OIDC_KIND_ID,
  OIDC_KIND_VERSION,
  OIDC_OUTPUT_FIELDS,
  type OidcCapability,
  type OidcOutputs,
  type OidcSpec,
} from "./oidc.generated.ts";

export type { OidcCapability, OidcOutputs, OidcSpec };

/**
 * `oidc@v1` component kind descriptor. Materialized by the Takosumi
 * Accounts provider plugin which issues a per-Installation OIDC client
 * at Installation creation and exposes issuer / client / secret /
 * redirect_uris as outputs.
 *
 * Spec / outputs / capabilities are derived from
 * `spec/contexts/kinds/v1/oidc.jsonld` via `oidc.generated.ts`;
 * validation diagnostics are hand-written below.
 */
export const OidcKind: Shape<OidcSpec, OidcOutputs, OidcCapability> = {
  id: OIDC_KIND_ID,
  version: OIDC_KIND_VERSION,
  description: OIDC_DESCRIPTION,
  capabilities: OIDC_CAPABILITIES,
  outputFields: OIDC_OUTPUT_FIELDS,
  validateSpec(value, issues) {
    if (!requireRoot(value, issues)) return;
    if (!Array.isArray(value.redirectPaths)) {
      issues.push({
        path: "$.redirectPaths",
        message: "must be an array",
      });
    } else if (value.redirectPaths.length === 0) {
      issues.push({
        path: "$.redirectPaths",
        message: "must declare at least one redirect path",
      });
    } else {
      for (const [index, entry] of value.redirectPaths.entries()) {
        const path = `$.redirectPaths[${index}]`;
        if (!isNonEmptyString(entry)) {
          issues.push({ path, message: "must be a non-empty string" });
        } else if (!entry.startsWith("/")) {
          issues.push({
            path,
            message: "must be an absolute URL path (start with `/`)",
          });
        }
      }
    }
    if (!Array.isArray(value.scopes)) {
      issues.push({ path: "$.scopes", message: "must be an array" });
    } else if (value.scopes.length === 0) {
      issues.push({
        path: "$.scopes",
        message: "must declare at least one scope",
      });
    } else {
      for (const [index, entry] of value.scopes.entries()) {
        if (!isNonEmptyString(entry)) {
          issues.push({
            path: `$.scopes[${index}]`,
            message: "must be a non-empty string",
          });
        }
      }
    }
  },
  validateOutputs(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.OIDC_ISSUER_URL, "$.OIDC_ISSUER_URL", issues);
    requireNonEmptyString(value.OIDC_CLIENT_ID, "$.OIDC_CLIENT_ID", issues);
    requireNonEmptyString(
      value.OIDC_CLIENT_SECRET,
      "$.OIDC_CLIENT_SECRET",
      issues,
    );
    requireNonEmptyString(
      value.OIDC_REDIRECT_URIS,
      "$.OIDC_REDIRECT_URIS",
      issues,
    );
  },
};
