import type { Shape } from "takosumi-contract";
import {
  isNonEmptyString,
  requireNonEmptyString,
  requireRoot,
} from "./_validators.ts";

/**
 * `oidc@v1` component kind.
 *
 * The Takosumi installer pipeline detects `kind: oidc` components at
 * Installation creation, registers a per-Installation OIDC client at the
 * Takosumi Accounts API, and surfaces issuer / client_id / client_secret /
 * redirect_uris as outputs that downstream `use:` edges with `mount: oidc`
 * (or env injection) consume.
 */
export type OidcCapability =
  | "authorization-code-pkce"
  | "client-credentials"
  | "refresh-token"
  | "id-token-signing";

export interface OidcSpec {
  /** Absolute redirect paths (e.g. `["/oidc/callback"]`). */
  readonly redirectPaths: readonly string[];
  /** OIDC / OAuth2 scopes requested (e.g. `["openid", "email"]`). */
  readonly scopes: readonly string[];
}

export interface OidcOutputs {
  readonly OIDC_ISSUER_URL: string;
  readonly OIDC_CLIENT_ID: string;
  readonly OIDC_CLIENT_SECRET: string;
  readonly OIDC_REDIRECT_URIS: string;
}

const CAPABILITIES: readonly OidcCapability[] = [
  "authorization-code-pkce",
  "client-credentials",
  "refresh-token",
  "id-token-signing",
];

const OUTPUT_FIELDS: readonly string[] = [
  "OIDC_ISSUER_URL",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_REDIRECT_URIS",
];

/**
 * `oidc@v1` component kind descriptor. Materialized by the Takosumi
 * Accounts provider plugin which issues a per-Installation OIDC client
 * at Installation creation and exposes issuer / client / secret /
 * redirect_uris as outputs.
 */
export const OidcKind: Shape<OidcSpec, OidcOutputs, OidcCapability> = {
  id: "oidc",
  version: "v1",
  description: "Per-Installation OIDC client issued by Takosumi Accounts.",
  capabilities: CAPABILITIES,
  outputFields: OUTPUT_FIELDS,
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
