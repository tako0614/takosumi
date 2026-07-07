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
  readonly providerEnvId?: string;
  readonly phase:
    | "source"
    | "normalize"
    | "build"
    | "plan"
    | "apply"
    | "destroy";
  /**
   * Legacy physical column name. For provider credential mints this stores
   * provider keys. For source sync it stores `source`.
   */
  readonly capabilities: readonly string[];
  /**
   * Non-secret evidence captured at mint time. This records whether provider
   * credentials were delivered only to the generated root and whether the
   * provider-specific mint produced temporary credentials with an expiry. It
   * must never contain credential values.
   */
  readonly providerCredentialEvidence?: readonly ProviderCredentialMintEvidence[];
  readonly actorId?: string;
  readonly createdAt: string;
}

export interface ProviderCredentialMintEvidence {
  readonly providerEnvId: string;
  readonly connectionId?: string;
  readonly provider: string;
  readonly delivery: "provider_env" | "generated_root_variable";
  readonly rootOnly: boolean;
  readonly temporary: boolean;
  readonly ttlEnforced: boolean;
  readonly expiresAt?: string;
  readonly ttlSeconds?: number;
  readonly issuer?:
    | "aws_sts_assume_role"
    | "cloudflare_api_token_vending"
    | "takosumi_managed_provider_token"
    | "static_secret";
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
