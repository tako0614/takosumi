/**
 * Takosumi process roles.
 *
 * These roles are deployment/runtime entrypoints for the same takosumi
 * product root. They are not semantic microservice boundaries.
 *
 * OpenTofu execution is represented by Runner/RunnerProfile and dispatched by
 * the host's queue/runner adapter. There is no fake background process role.
 */
export const TAKOSUMI_PROCESS_ROLES = ["takosumi-api"] as const;

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
} as const satisfies Record<TakosumiProcessRole, TakosumiProcessRoleDescription>;

export function isTakosumiProcessRole(value: string): value is TakosumiProcessRole {
  return TAKOSUMI_PROCESS_ROLES.includes(value as TakosumiProcessRole);
}

export function describeTakosumiProcessRole(
  role: TakosumiProcessRole,
): TakosumiProcessRoleDescription {
  return TAKOSUMI_PROCESS_ROLE_DESCRIPTIONS[role];
}
