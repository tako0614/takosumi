import {
  TAKOS_INTERNAL_ACTOR_HEADER,
  type TakosActorContext,
} from "takosumi-contract";
import {
  decodeActorContext,
  signTakosInternalRequest,
  verifyTakosInternalRequestFromHeaders,
} from "takosumi-contract/internal-rpc";
import type { ActorAdapter, AuthPort, AuthResult } from "./types.ts";

export interface ServiceActorAuthAdapterOptions {
  readonly secret: string;
  readonly caller?: string;
  readonly audience?: string;
  readonly clock?: () => Date;
}

export class ServiceActorAuthAdapter implements ActorAdapter, AuthPort {
  readonly #secret: string;
  readonly #caller: string;
  readonly #audience: string;
  readonly #clock: () => Date;

  constructor(options: ServiceActorAuthAdapterOptions) {
    this.#secret = options.secret;
    this.#caller = options.caller ?? "takos-service";
    this.#audience = options.audience ?? "takosumi";
    this.#clock = options.clock ?? (() => new Date());
  }

  async actorForRequest(request: Request): Promise<TakosActorContext> {
    const result = await this.authenticate(request);
    if (!result.ok) throw new Error(result.error);
    return result.actor;
  }

  async authenticate(request: Request): Promise<AuthResult> {
    const actorHeader = request.headers.get(TAKOS_INTERNAL_ACTOR_HEADER);
    if (!actorHeader) return unauthorized("missing actor context");

    let actor: TakosActorContext;
    try {
      actor = decodeActorContext(actorHeader);
    } catch {
      return unauthorized("invalid actor context");
    }

    const body = await request.clone().text();
    const url = new URL(request.url);
    const verified = await verifyTakosInternalRequestFromHeaders({
      method: request.method,
      path: url.pathname,
      query: url.search,
      body,
      secret: this.#secret,
      headers: request.headers,
      now: this.#clock,
      expectedAudience: this.#audience,
    });
    if (!verified) return unauthorized("invalid internal signature");
    actor = verified.actor;
    return { ok: true, actor: Object.freeze(structuredClone(actor)) };
  }

  async signRequest(input: {
    readonly method: string;
    readonly path: string;
    readonly query?: string;
    readonly body?: string;
    readonly actor: TakosActorContext;
  }): Promise<Headers> {
    const path = splitPathAndQuery(input.path, input.query);
    const signed = await signTakosInternalRequest({
      method: input.method,
      path: path.pathname,
      query: path.query,
      body: input.body ?? "",
      timestamp: this.#clock().toISOString(),
      actor: input.actor,
      caller: this.#caller,
      audience: this.#audience,
      secret: this.#secret,
    });
    return new Headers(signed.headers);
  }
}

function unauthorized(error: string): AuthResult {
  return { ok: false, error, status: 401 };
}

function splitPathAndQuery(
  path: string,
  query: string | undefined,
): { readonly pathname: string; readonly query?: string } {
  const separator = path.indexOf("?");
  if (separator < 0) return { pathname: path, query };
  return {
    pathname: path.slice(0, separator),
    query: query ?? path.slice(separator),
  };
}
