/**
 * Takosumi process roles.
 *
 * These roles are deployment/runtime entrypoints for the same takosumi
 * product root. They are not semantic microservice boundaries.
 *
 * The live worker only instantiates `takosumi-api` and `takosumi-runtime-agent`
 * (see `worker/src/handler.ts`); `takosumi-worker` remains as the
 * background-daemon entrypoint consumed by `bootstrap/worker_daemon.ts` and the
 * Bun server target. The previous per-role capability/guard matrix (a stale
 * microservice model that was never enforced) has been removed.
 */
export const TAKOSUMI_PROCESS_ROLES = [
  "takosumi-api",
  "takosumi-worker",
  "takosumi-runtime-agent",
] as const;

export type TakosumiProcessRole = typeof TAKOSUMI_PROCESS_ROLES[number];

export interface TakosumiProcessRoleDescription {
  readonly role: TakosumiProcessRole;
  readonly description: string;
}

export const TAKOSUMI_PROCESS_ROLE_DESCRIPTIONS = {
  "takosumi-api": {
    role: "takosumi-api",
    description: "HTTP API and internal API host for the Takosumi service.",
  },
  "takosumi-worker": {
    role: "takosumi-worker",
    description: "Background apply, materialization, and outbox worker role.",
  },
  "takosumi-runtime-agent": {
    role: "takosumi-runtime-agent",
    description: "Runtime agent lease and observed-state reporting role.",
  },
} as const satisfies Record<TakosumiProcessRole, TakosumiProcessRoleDescription>;

export function isTakosumiProcessRole(value: string): value is TakosumiProcessRole {
  return TAKOSUMI_PROCESS_ROLES.includes(value as TakosumiProcessRole);
}

export function describeTakosumiProcessRole(
  role: TakosumiProcessRole,
): TakosumiProcessRoleDescription {
  return TAKOSUMI_PROCESS_ROLE_DESCRIPTIONS[role];
}
