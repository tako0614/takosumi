/**
 * Minimal workerd RPC type used by the platform entry module.
 *
 * The Worker typecheck intentionally does not load the global
 * `@cloudflare/workers-types` package. Keep this declaration limited to the
 * runtime-owned base class that the named Service Binding entrypoint needs
 * and the per-invocation `waitUntil`.
 */
declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected readonly env: Env;
  }
  /**
   * Extends the request or Durable Object invocation that is executing the
   * caller, like that invocation's `ctx.waitUntil` (TASK-0119 notifications).
   */
  export function waitUntil(promise: Promise<unknown>): void;
}
