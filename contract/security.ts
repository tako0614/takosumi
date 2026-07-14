/**
 * Security finding and credential mint audit records.
 */

export interface CredentialMintEvent {
  readonly id: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly capsuleId?: string;
  readonly sourceId?: string;
  readonly connectionId?: string;
  readonly phase:
    "source" | "normalize" | "build" | "plan" | "apply" | "destroy";
  /**
   * Legacy physical column name. For provider credential mints this stores
   * provider keys. For source sync it stores `source`.
   */
  readonly capabilities: readonly string[];
  /**
   * Non-secret evidence captured at mint time. This records whether the
   * recipe/issuer produced temporary credentials with an expiry. It must never
   * contain credential values or depend on how a root module represents
   * provider configuration.
   */
  readonly providerCredentialEvidence?: readonly ProviderCredentialMintEvidence[];
  readonly actorId?: string;
  readonly createdAt: string;
}

export interface ProviderCredentialMintEvidence {
  readonly connectionId: string;
  readonly provider: string;
  readonly temporary: boolean;
  readonly ttlEnforced: boolean;
  readonly expiresAt?: string;
  readonly ttlSeconds?: number;
  /** Open recipe/issuer driver token; adding a driver needs no contract enum edit. */
  readonly issuer?: string;
  readonly secretValueStored?: false;
}

export interface SecurityFinding {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId?: string;
  readonly runId?: string;
  readonly severity: "info" | "warning" | "error" | "critical";
  readonly type: string;
  readonly message: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}
