import type { provider } from "takosumi-contract";

export interface CloudflareProviderClient {
  materializeDesiredState(
    desiredState: Parameters<provider.ProviderMaterializer["materialize"]>[0],
  ): Promise<provider.ProviderMaterializationPlan>;
  reconcileDesiredState?(
    desiredState: Parameters<provider.ProviderMaterializer["materialize"]>[0],
  ): Promise<provider.ProviderMaterializationPlan>;
  verifyDesiredState?(
    desiredState: Parameters<provider.ProviderMaterializer["materialize"]>[0],
  ): Promise<CloudflareProviderDesiredStateVerificationReport>;
  teardownDesiredState?(
    desiredState: Parameters<provider.ProviderMaterializer["materialize"]>[0],
  ): Promise<provider.ProviderMaterializationPlan | void>;
  listOperations(): Promise<readonly provider.ProviderOperation[]>;
  clearOperations(): Promise<void>;
  detectDrift?(input: unknown): Promise<unknown>;
}

export interface CloudflareProviderDesiredStateVerificationReport {
  readonly provider?: "cloudflare" | string;
  readonly desiredStateId?: string;
  readonly verifiedAt?: string;
  readonly ok?: boolean;
  readonly status?: string;
  readonly checks?: readonly Record<string, unknown>[];
  readonly details?: Record<string, unknown>;
}
