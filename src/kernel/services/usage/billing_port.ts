import type { UsageAggregate, UsageEventDto } from "./types.ts";

export interface BillingUsageProjectionNotice {
  readonly event: UsageEventDto;
  readonly aggregate: UsageAggregate;
}

export interface BillingPort {
  projectUsage(notice: BillingUsageProjectionNotice): Promise<void>;
}

export class NoopBillingPort implements BillingPort {
  projectUsage(_notice: BillingUsageProjectionNotice): Promise<void> {
    return Promise.resolve();
  }
}

export interface HttpBillingPortOptions {
  readonly baseUrl: string;
  readonly secret: string;
  readonly fetch?: typeof fetch;
}

export class HttpBillingPort implements BillingPort {
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #fetch: typeof fetch;

  constructor(options: HttpBillingPortOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#secret = options.secret;
    this.#fetch = options.fetch ?? fetch;
  }

  async projectUsage(notice: BillingUsageProjectionNotice): Promise<void> {
    const response = await this.#fetch(
      `${this.#baseUrl}/api/internal/v1/billing/usage-events`,
      {
        method: "POST",
        headers: {
          "authorization": `Bearer ${this.#secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          event: notice.event,
          aggregate: notice.aggregate,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Billing usage projection failed: ${response.status}`);
    }
  }
}
