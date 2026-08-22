/**
 * Minimal workerd RPC type used by the platform entry module.
 *
 * The Worker typecheck intentionally does not load the global
 * `@cloudflare/workers-types` package. Keep this declaration limited to the
 * runtime-owned base class that the named Service Binding entrypoint needs.
 */
declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected readonly env: Env;
  }
}
