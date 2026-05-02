import type { TakosumiActorContext } from "takosumi-contract";

export type AuthResult =
  | { readonly ok: true; readonly actor: TakosumiActorContext }
  | { readonly ok: false; readonly error: string; readonly status: 401 | 403 };

export interface AuthPort {
  authenticate(request: Request): Promise<AuthResult>;
}

export interface ActorAdapter {
  actorForRequest(request: Request): Promise<TakosumiActorContext>;
}
