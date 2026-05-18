/**
 * Canonical kind URIs of the 4 built-in Takosumi component kinds, re-
 * exported from the contract so the bundled wrappers reference them by
 * name instead of repeating the literal URI in each file.
 *
 * Phase B: `oidc` is no longer a built-in kernel kind (moved to Takosumi
 * Accounts). The literal URI is retained here as a Phase D bridge so the
 * existing `oidc-takosumi-accounts` bundled connector still compiles; the
 * connector itself is being repackaged in Phase D.
 */

import { KIND_URI_BY_NAME } from "takosumi-contract/app-spec";

export const KIND_URI_WORKER = KIND_URI_BY_NAME.worker;
export const KIND_URI_POSTGRES = KIND_URI_BY_NAME.postgres;
export const KIND_URI_OBJECT_STORE = KIND_URI_BY_NAME["object-store"];
export const KIND_URI_CUSTOM_DOMAIN = KIND_URI_BY_NAME["custom-domain"];

/**
 * Legacy bridge URI for the `oidc` kind. Not a built-in kernel kind any
 * more — this constant exists only so the Phase D-pending
 * `oidc-takosumi-accounts` connector compiles against the new contract.
 */
export const KIND_URI_OIDC = "https://takosumi.com/kinds/v1/oidc";
