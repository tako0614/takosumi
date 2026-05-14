/**
 * `DirectCloudflareR2Lifecycle` — calls Cloudflare R2 REST API directly.
 *
 * Endpoint: /accounts/{accountId}/r2/buckets
 */

import {
  cfFetch,
  cfFetchValidated,
  ensureCfOk,
} from "../../_cloudflare_api.ts";
import { parseCloudflareR2Result } from "../_wire.ts";

export interface CloudflareR2BucketDescriptor {
  readonly accountId: string;
  readonly bucketName: string;
  readonly locationHint?: string;
  readonly publicAccess?: boolean;
}

export interface CloudflareR2BucketCreateInput {
  readonly bucketName: string;
  readonly locationHint?: string;
  readonly publicAccess?: boolean;
}

export interface DirectCloudflareR2LifecycleOptions {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
}

export class DirectCloudflareR2Lifecycle {
  readonly #accountId: string;
  readonly #apiToken: string;
  readonly #fetch?: typeof fetch;

  constructor(options: DirectCloudflareR2LifecycleOptions) {
    this.#accountId = options.accountId;
    this.#apiToken = options.apiToken;
    this.#fetch = options.fetch;
  }

  async createBucket(
    input: CloudflareR2BucketCreateInput,
  ): Promise<CloudflareR2BucketDescriptor> {
    const body: Record<string, unknown> = { name: input.bucketName };
    if (input.locationHint) body.locationHint = input.locationHint;
    const context = `r2:CreateBucket ${input.bucketName}`;
    const result = await cfFetchValidated(
      {
        method: "POST",
        path: `/accounts/${this.#accountId}/r2/buckets`,
        body,
      },
      { apiToken: this.#apiToken, fetch: this.#fetch },
      parseCloudflareR2Result,
      context,
    );
    if (result.status !== 409) {
      ensureCfOk(result, context);
    }
    return {
      accountId: this.#accountId,
      bucketName: input.bucketName,
      locationHint: input.locationHint,
      publicAccess: input.publicAccess,
    };
  }

  async describeBucket(
    input: { readonly bucketName: string },
  ): Promise<CloudflareR2BucketDescriptor | undefined> {
    const context = `r2:GetBucket ${input.bucketName}`;
    const result = await cfFetchValidated(
      {
        method: "GET",
        path: `/accounts/${this.#accountId}/r2/buckets/${input.bucketName}`,
      },
      { apiToken: this.#apiToken, fetch: this.#fetch },
      parseCloudflareR2Result,
      context,
    );
    if (result.status === 404) return undefined;
    ensureCfOk(result, context);
    return {
      accountId: this.#accountId,
      bucketName: input.bucketName,
      locationHint: result.envelope?.result?.location,
    };
  }

  /**
   * Verify-only: list R2 buckets for the configured account. Returns raw
   * status / text so the connector can produce a verify result without
   * throwing.
   */
  listBucketsResult(): Promise<
    { status: number; ok: boolean; text: string }
  > {
    return cfFetch(
      {
        method: "GET",
        path: `/accounts/${this.#accountId}/r2/buckets`,
      },
      { apiToken: this.#apiToken, fetch: this.#fetch },
    ).then((result) => ({
      status: result.status,
      ok: result.envelope?.success === true && result.status >= 200 &&
        result.status < 300,
      text: result.text,
    }));
  }

  async deleteBucket(
    input: { readonly bucketName: string },
  ): Promise<boolean> {
    const result = await cfFetch(
      {
        method: "DELETE",
        path: `/accounts/${this.#accountId}/r2/buckets/${input.bucketName}`,
      },
      { apiToken: this.#apiToken, fetch: this.#fetch },
    );
    if (result.status === 404) return false;
    ensureCfOk(result, `r2:DeleteBucket ${input.bucketName}`);
    return true;
  }
}
