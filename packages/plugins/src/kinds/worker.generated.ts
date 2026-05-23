// AUTO-GENERATED FROM packages/plugins/spec/kinds/v1/worker.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

import type { Artifact } from "takosumi-contract";

export interface WorkerSpec {
  /** Resolved uploaded artifact descriptor. `kind` must be `js-bundle` and `hash` is required. */
  readonly artifact: Artifact;
  /** Cloudflare Workers compatibility date (e.g. `2025-01-01`). */
  readonly compatibilityDate: string;
  /** Optional compatibility flags (e.g. `nodejs_compat`). */
  readonly compatibilityFlags?: readonly string[];
  /** Optional env vars / bindings. */
  readonly env?: Readonly<Record<string, string>>;
  readonly [extension: string]: unknown;
}

export interface WorkerOutputs {
  /** Allocated public URL (scheme-bearing). */
  readonly url: string;
  /** Provider-scope worker identifier. */
  readonly id: string;
  /** Current deployed bundle version. */
  readonly version?: string;
}

export type WorkerCapability =
  | "scale-to-zero"
  | "long-request"
  | "geo-routing";

export type WorkerPublishesTo = "<app-id>.<component-name>";

export type WorkerListensFrom = "<sibling-namespace-path>";

export const WORKER_CAPABILITIES: readonly WorkerCapability[] = [
  "scale-to-zero",
  "long-request",
  "geo-routing",
];

export const WORKER_OUTPUT_FIELDS: readonly string[] = [
  "url",
  "id",
  "version",
];

export const WORKER_ALIASES: readonly string[] = [
  "worker",
];

export const WORKER_PUBLISHES_TO: readonly WorkerPublishesTo[] = [
  "<app-id>.<component-name>",
];

export const WORKER_LISTENS_FROM: readonly WorkerListensFrom[] = [
  "<sibling-namespace-path>",
];

export const WORKER_KIND_ID = "worker";
export const WORKER_KIND_VERSION = "v1";
export const WORKER_DESCRIPTION =
  "Serverless JS function backed by an uploaded `js-bundle` artifact descriptor.";
