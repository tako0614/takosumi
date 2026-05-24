// AUTO-GENERATED FROM packages/plugins/spec/kinds/v1/worker.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface WorkerSpec {
  /** Source-root-relative worker module path inside the prepared source snapshot. */
  readonly entrypoint: string;
  /** Optional provider compatibility date for runtimes that use one (for example Cloudflare Workers). */
  readonly compatibilityDate?: string;
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
  /** Current deployed worker version. */
  readonly version?: string;
}

export type WorkerCapability =
  | "scale-to-zero"
  | "long-request"
  | "geo-routing";

export type WorkerPublicationName = "http";

export type WorkerListenBindingName = "binding";

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

export const WORKER_PUBLICATIONS: readonly WorkerPublicationName[] = [
  "http",
];

export const WORKER_LISTEN_BINDINGS: readonly WorkerListenBindingName[] = [
  "binding",
];

export const WORKER_KIND_ID = "worker";
export const WORKER_KIND_NAME = "worker";
export const WORKER_KIND_URI = "https://takosumi.com/kinds/v1/worker";
export const WORKER_KIND_VERSION = "v1";
export const WORKER_DESCRIPTION =
  "Serverless JS function whose entrypoint is read from the prepared source snapshot.";
