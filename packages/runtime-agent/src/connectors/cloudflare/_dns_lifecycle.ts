/**
 * `DirectCloudflareDnsLifecycle` — calls Cloudflare DNS REST API directly.
 *
 * Endpoint: /zones/{zoneId}/dns_records
 */

import { cfFetch, ensureCfOk } from "../../_cloudflare_api.ts";

export interface CloudflareDnsRecordDescriptor {
  readonly recordId: string;
  readonly fqdn: string;
  readonly target: string;
  readonly proxied: boolean;
  readonly zoneId: string;
}

export interface CloudflareDnsCreateRecordInput {
  readonly fqdn: string;
  readonly target: string;
  readonly proxied: boolean;
}

export interface DirectCloudflareDnsLifecycleOptions {
  readonly zoneId: string;
  readonly apiToken: string;
  readonly recordType?: "A" | "AAAA" | "CNAME";
  readonly ttlSeconds?: number;
  readonly fetch?: typeof fetch;
}

export class DirectCloudflareDnsLifecycle {
  readonly #zoneId: string;
  readonly #apiToken: string;
  readonly #recordType: "A" | "AAAA" | "CNAME";
  readonly #ttl: number;
  readonly #fetch?: typeof fetch;

  constructor(options: DirectCloudflareDnsLifecycleOptions) {
    this.#zoneId = options.zoneId;
    this.#apiToken = options.apiToken;
    this.#recordType = options.recordType ?? "CNAME";
    this.#ttl = options.ttlSeconds ?? 1; // 1 = automatic in Cloudflare
    this.#fetch = options.fetch;
  }

  async createRecord(
    input: CloudflareDnsCreateRecordInput,
  ): Promise<CloudflareDnsRecordDescriptor> {
    const body = {
      type: this.#recordType,
      name: input.fqdn,
      content: input.target,
      ttl: this.#ttl,
      proxied: input.proxied,
    };
    const result = await cfFetch<{ id: string }>(
      {
        method: "POST",
        path: `/zones/${this.#zoneId}/dns_records`,
        body,
      },
      { apiToken: this.#apiToken, fetch: this.#fetch },
    );
    const record = ensureCfOk(
      result,
      `cf-dns:CreateRecord ${input.fqdn}`,
    );
    return {
      recordId: record.id,
      fqdn: input.fqdn,
      target: input.target,
      proxied: input.proxied,
      zoneId: this.#zoneId,
    };
  }

  async describeRecord(
    input: { readonly recordId: string },
  ): Promise<CloudflareDnsRecordDescriptor | undefined> {
    const result = await cfFetch<{
      id: string;
      name: string;
      content: string;
      proxied: boolean;
    }>(
      {
        method: "GET",
        path: `/zones/${this.#zoneId}/dns_records/${input.recordId}`,
      },
      { apiToken: this.#apiToken, fetch: this.#fetch },
    );
    if (result.status === 404) return undefined;
    const record = ensureCfOk(
      result,
      `cf-dns:GetRecord ${input.recordId}`,
    );
    return {
      recordId: record.id,
      fqdn: record.name,
      target: record.content,
      proxied: record.proxied,
      zoneId: this.#zoneId,
    };
  }

  async deleteRecord(
    input: { readonly recordId: string },
  ): Promise<boolean> {
    const result = await cfFetch(
      {
        method: "DELETE",
        path: `/zones/${this.#zoneId}/dns_records/${input.recordId}`,
      },
      { apiToken: this.#apiToken, fetch: this.#fetch },
    );
    if (result.status === 404) return false;
    ensureCfOk(result, `cf-dns:DeleteRecord ${input.recordId}`);
    return true;
  }
}
