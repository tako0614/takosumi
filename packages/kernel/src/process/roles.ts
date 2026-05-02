/**
 * Takosumi process roles.
 *
 * These roles are deployment/runtime entrypoints for the same takos-paas
 * product root. They are not semantic microservice boundaries.
 */
export const PAAS_PROCESS_ROLES = [
  "takosumi-api",
  "takosumi-worker",
  "takosumi-router",
  "takosumi-runtime-agent",
  "takosumi-log-worker",
] as const;

export type PaaSProcessRole = typeof PAAS_PROCESS_ROLES[number];

export type PaaSProcessCapability =
  | "api.health.read"
  | "api.capabilities.read"
  | "api.public.host"
  | "api.internal.host"
  | "internal.auth.verify"
  | "worker.deploy.apply"
  | "worker.runtime.materialize"
  | "worker.outbox.consume"
  | "router.route.project"
  | "router.route.serve"
  | "runtime.agent.lease"
  | "runtime.agent.observe"
  | "logs.consume"
  | "logs.project";

export type PaaSProcessGuard =
  | "internal-service-auth"
  | "actor-context-required"
  | "role-capability-required"
  | "mutation-boundary-authz"
  | "provider-state-non-canonical"
  | "no-plaintext-operator-secrets";

export interface PaaSProcessRoleDescription {
  readonly role: PaaSProcessRole;
  readonly description: string;
  readonly capabilities: readonly PaaSProcessCapability[];
  readonly guards: readonly PaaSProcessGuard[];
}

const COMMON_READ_CAPABILITIES = [
  "api.health.read",
  "api.capabilities.read",
] as const satisfies readonly PaaSProcessCapability[];

const INTERNAL_API_GUARDS = [
  "internal-service-auth",
  "actor-context-required",
  "role-capability-required",
  "mutation-boundary-authz",
] as const satisfies readonly PaaSProcessGuard[];

export const PAAS_PROCESS_ROLE_DESCRIPTIONS = {
  "takosumi-api": {
    role: "takosumi-api",
    description: "HTTP API and internal API host for the PaaS control plane.",
    capabilities: [
      ...COMMON_READ_CAPABILITIES,
      "api.public.host",
      "api.internal.host",
      "internal.auth.verify",
    ],
    guards: INTERNAL_API_GUARDS,
  },
  "takosumi-worker": {
    role: "takosumi-worker",
    description: "Background apply, materialization, and outbox worker role.",
    capabilities: [
      ...COMMON_READ_CAPABILITIES,
      "worker.deploy.apply",
      "worker.runtime.materialize",
      "worker.outbox.consume",
    ],
    guards: [
      "role-capability-required",
      "mutation-boundary-authz",
      "provider-state-non-canonical",
      "no-plaintext-operator-secrets",
    ],
  },
  "takosumi-router": {
    role: "takosumi-router",
    description: "Route projection and serving edge role.",
    capabilities: [
      ...COMMON_READ_CAPABILITIES,
      "router.route.project",
      "router.route.serve",
    ],
    guards: [
      "role-capability-required",
      "provider-state-non-canonical",
    ],
  },
  "takosumi-runtime-agent": {
    role: "takosumi-runtime-agent",
    description: "Runtime agent lease and observed-state reporting role.",
    capabilities: [
      ...COMMON_READ_CAPABILITIES,
      "runtime.agent.lease",
      "runtime.agent.observe",
    ],
    guards: [
      "internal-service-auth",
      "actor-context-required",
      "role-capability-required",
      "provider-state-non-canonical",
      "no-plaintext-operator-secrets",
    ],
  },
  "takosumi-log-worker": {
    role: "takosumi-log-worker",
    description: "Log ingestion and security/audit projection worker role.",
    capabilities: [
      ...COMMON_READ_CAPABILITIES,
      "logs.consume",
      "logs.project",
    ],
    guards: [
      "role-capability-required",
      "no-plaintext-operator-secrets",
    ],
  },
} as const satisfies Record<PaaSProcessRole, PaaSProcessRoleDescription>;

export function isPaaSProcessRole(value: string): value is PaaSProcessRole {
  return PAAS_PROCESS_ROLES.includes(value as PaaSProcessRole);
}

export function describePaaSProcessRole(
  role: PaaSProcessRole,
): PaaSProcessRoleDescription {
  return PAAS_PROCESS_ROLE_DESCRIPTIONS[role];
}

export function roleHasCapability(
  role: PaaSProcessRole,
  capability: PaaSProcessCapability,
): boolean {
  const capabilities: readonly PaaSProcessCapability[] =
    PAAS_PROCESS_ROLE_DESCRIPTIONS[role].capabilities;
  return capabilities.includes(capability);
}

export function assertRoleCapability(
  role: PaaSProcessRole,
  capability: PaaSProcessCapability,
): void {
  if (!roleHasCapability(role, capability)) {
    throw new PaaSProcessCapabilityError(role, capability);
  }
}

export class PaaSProcessCapabilityError extends Error {
  constructor(
    readonly role: PaaSProcessRole,
    readonly capability: PaaSProcessCapability,
  ) {
    super(`PaaS process role ${role} does not provide ${capability}`);
    this.name = "PaaSProcessCapabilityError";
  }
}
