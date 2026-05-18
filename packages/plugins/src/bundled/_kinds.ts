/**
 * Canonical kind URIs of the 5 built-in Takosumi component kinds, re-
 * exported from the contract so the bundled wrappers reference them by
 * name instead of repeating the literal URI in each file.
 */

import { KIND_URI_BY_NAME } from "takosumi-contract/app-spec";

export const KIND_URI_WORKER = KIND_URI_BY_NAME.worker;
export const KIND_URI_POSTGRES = KIND_URI_BY_NAME.postgres;
export const KIND_URI_OBJECT_STORE = KIND_URI_BY_NAME["object-store"];
export const KIND_URI_OIDC = KIND_URI_BY_NAME.oidc;
export const KIND_URI_CUSTOM_DOMAIN = KIND_URI_BY_NAME["custom-domain"];
