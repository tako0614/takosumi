import { WorkerEntrypoint } from "cloudflare:workers";
import { PrivateStateRecoveryRefusal, type PrivateStateRecoveryOperator } from "./private-state-recovery.ts";

/**
 * Owner module exports the returned class under its explicit named entrypoint.
 * The closure constructs a same-realm operator from real env bindings; function
 * objects are never presumed to be Cloudflare bindings or supplied over RPC.
 */
export function composePrivateStateRecoveryWorker<Env>(
  compose: (env: Env) => PrivateStateRecoveryOperator,
) {
  return class PrivateStateRecoveryWorker extends WorkerEntrypoint<Env> {
    #operator: PrivateStateRecoveryOperator | undefined;
    #recovery() {
      try {
        if (typeof compose !== "function") throw new PrivateStateRecoveryRefusal();
        const operator = this.#operator ?? compose(this.env);
        if (!operator || typeof operator.stageRecoveryState !== "function" ||
          typeof operator.commitRecoveryState !== "function") throw new PrivateStateRecoveryRefusal();
        return this.#operator = operator;
      } catch { throw new PrivateStateRecoveryRefusal(); }
    }
    fetch(): Response { return new Response(null, { status: 404 }); }
    stageRecoveryState(input: unknown) { return this.#recovery().stageRecoveryState(input); }
    commitRecoveryState(input: unknown) { return this.#recovery().commitRecoveryState(input); }
  };
}
