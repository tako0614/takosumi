import type { TakosActorContext } from "takosumi-contract";
import type { ActorAdapter, AuthPort, AuthResult } from "./types.ts";

export interface LocalActorAuthAdapterOptions {
  readonly actor?: TakosActorContext;
  readonly actorFactory?: (
    request: Request,
  ) => TakosActorContext | Promise<TakosActorContext>;
}

export class LocalActorAdapter implements ActorAdapter, AuthPort {
  readonly #actorFactory: (
    request: Request,
  ) => TakosActorContext | Promise<TakosActorContext>;

  constructor(options: LocalActorAuthAdapterOptions = {}) {
    this.#actorFactory = options.actorFactory ?? (() =>
      options.actor ?? {
        actorAccountId: "local-operator",
        roles: ["owner"],
        requestId: crypto.randomUUID(),
      });
  }

  async actorForRequest(request: Request): Promise<TakosActorContext> {
    return freezeClone(await this.#actorFactory(request));
  }

  async authenticate(request: Request): Promise<AuthResult> {
    try {
      return { ok: true, actor: await this.actorForRequest(request) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "local actor rejected",
        status: 403,
      };
    }
  }
}

function freezeClone<T>(value: T): T {
  return Object.freeze(structuredClone(value));
}
