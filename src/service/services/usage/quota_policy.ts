import type { UsageQuotaLimits, UsageQuotaTierAssignment } from "./types.ts";

export interface UsageQuotaPolicyPort {
  getQuotaTier(spaceId: string): Promise<UsageQuotaTierAssignment | undefined>;
}

export interface UsageQuotaTierConfig {
  readonly limits?: UsageQuotaLimits;
}

export interface UsageQuotaSpaceOverride {
  readonly tierId?: string;
  readonly limits?: UsageQuotaLimits;
}

export interface LocalUsageQuotaPolicyConfig {
  readonly defaultTierId?: string;
  readonly tiers?: Record<string, UsageQuotaTierConfig>;
  readonly spaces?: Record<string, string | UsageQuotaSpaceOverride>;
}

export const DEFAULT_USAGE_QUOTA_TIERS = Object.freeze(
  {
    free: {
      limits: {
        cpuMilliseconds: 3_600_000,
        storageBytes: 1_073_741_824,
        bandwidthBytes: 10_737_418_240,
      },
    },
    team: {
      limits: {
        cpuMilliseconds: 36_000_000,
        storageBytes: 107_374_182_400,
        bandwidthBytes: 1_099_511_627_776,
      },
    },
    enterprise: {
      limits: {},
    },
  } satisfies Record<string, UsageQuotaTierConfig>,
);

export class LocalUsageQuotaPolicy implements UsageQuotaPolicyPort {
  readonly #defaultTierId: string;
  readonly #tiers: Record<string, UsageQuotaTierConfig>;
  readonly #spaces: Record<string, string | UsageQuotaSpaceOverride>;

  constructor(config: LocalUsageQuotaPolicyConfig = {}) {
    this.#defaultTierId = config.defaultTierId ?? "free";
    this.#tiers = {
      ...DEFAULT_USAGE_QUOTA_TIERS,
      ...(config.tiers ?? {}),
    };
    this.#spaces = { ...(config.spaces ?? {}) };
  }

  getQuotaTier(spaceId: string): Promise<UsageQuotaTierAssignment | undefined> {
    const override = this.#spaces[spaceId];
    const tierId = typeof override === "string"
      ? override
      : override?.tierId ?? this.#defaultTierId;
    const tier = this.#tiers[tierId];
    if (!tier) return Promise.resolve(undefined);
    const limits = {
      ...(tier.limits ?? {}),
      ...(typeof override === "object" ? override.limits ?? {} : {}),
    };
    return Promise.resolve(Object.freeze({
      tierId,
      limits: Object.freeze(limits),
    }));
  }
}
