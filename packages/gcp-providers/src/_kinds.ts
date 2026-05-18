/**
 * Canonical kind URIs of the 4 built-in Takosumi component kinds, re-
 * exported from the contract so the provider wrappers reference them by
 * name instead of repeating the literal URI in each file.
 *
 * This is a per-package copy (Phase D extracted the bundled wrappers out
 * of `@takos/takosumi-plugins`; each `@takos/takosumi-<cloud>-providers`
 * package keeps its own copy so the kind URI binding lives next to the
 * factory it parameterises).
 */

import { KIND_URI_BY_NAME } from "takosumi-contract/app-spec";

export const KIND_URI_WORKER = KIND_URI_BY_NAME.worker;
export const KIND_URI_POSTGRES = KIND_URI_BY_NAME.postgres;
export const KIND_URI_OBJECT_STORE = KIND_URI_BY_NAME["object-store"];
export const KIND_URI_CUSTOM_DOMAIN = KIND_URI_BY_NAME["custom-domain"];
