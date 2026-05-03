/**
 * `DirectCloudDnsLifecycle` — calls GCP Cloud DNS REST API directly.
 *
 * Endpoint:
 * https://dns.googleapis.com/dns/v1/projects/{p}/managedZones/{zone}/rrsets
 */

import {
  ensureGcpResponseOk,
  GcpAccessTokenProvider,
  type GcpAccessTokenProviderOptions,
  gcpJsonFetch,
} from "../../_gcp_auth.ts";

export interface CloudDnsRecordDescriptor {
  readonly recordName: string;
  readonly fqdn: string;
  readonly target: string;
  readonly project: string;
  readonly zoneName: string;
}

export interface DirectCloudDnsLifecycleOptions
  extends GcpAccessTokenProviderOptions {
  readonly project: string;
  readonly zoneName: string;
  readonly ttlSeconds?: number;
}

export class DirectCloudDnsLifecycle {
  readonly #project: string;
  readonly #zoneName: string;
  readonly #ttl: number;
  readonly #tokens: GcpAccessTokenProvider;
  readonly #fetch?: typeof fetch;

  constructor(options: DirectCloudDnsLifecycleOptions) {
    this.#project = options.project;
    this.#zoneName = options.zoneName;
    this.#ttl = options.ttlSeconds ?? 300;
    this.#tokens = new GcpAccessTokenProvider(options);
    this.#fetch = options.fetch;
  }

  async createRecord(
    input: { readonly fqdn: string; readonly target: string },
  ): Promise<CloudDnsRecordDescriptor> {
    const body = {
      name: ensureTrailingDot(input.fqdn),
      type: "CNAME",
      ttl: this.#ttl,
      rrdatas: [ensureTrailingDot(input.target)],
    };
    const result = await gcpJsonFetch(this.#tokens, {
      method: "POST",
      url:
        `https://dns.googleapis.com/dns/v1/projects/${this.#project}/managedZones/${this.#zoneName}/rrsets`,
      body,
      fetch: this.#fetch,
    });
    if (result.status !== 409) {
      ensureGcpResponseOk(result, `clouddns:CreateRRSet ${input.fqdn}`);
    }
    return {
      recordName: this.#packId(input.fqdn, input.target),
      fqdn: input.fqdn,
      target: input.target,
      project: this.#project,
      zoneName: this.#zoneName,
    };
  }

  describeRecord(
    input: { readonly recordName: string },
  ): Promise<CloudDnsRecordDescriptor | undefined> {
    const parts = this.#unpackId(input.recordName);
    if (!parts) return Promise.resolve(undefined);
    return Promise.resolve({
      recordName: input.recordName,
      fqdn: parts.fqdn,
      target: parts.target,
      project: this.#project,
      zoneName: this.#zoneName,
    });
  }

  /**
   * Verify-only: list managed zones in the project. Returns raw status /
   * text so the connector can render a verify result without throwing.
   */
  listManagedZonesResult(): Promise<
    { status: number; ok: boolean; text: string }
  > {
    return gcpJsonFetch(this.#tokens, {
      method: "GET",
      url:
        `https://dns.googleapis.com/dns/v1/projects/${this.#project}/managedZones?maxResults=1`,
      fetch: this.#fetch,
    }).then((result) => ({
      status: result.status,
      ok: result.ok,
      text: result.text,
    }));
  }

  async deleteRecord(
    input: { readonly recordName: string },
  ): Promise<boolean> {
    const parts = this.#unpackId(input.recordName);
    if (!parts) return false;
    const path =
      `https://dns.googleapis.com/dns/v1/projects/${this.#project}/managedZones/${this.#zoneName}/rrsets/${
        encodeURIComponent(ensureTrailingDot(parts.fqdn))
      }/CNAME`;
    const result = await gcpJsonFetch(this.#tokens, {
      method: "DELETE",
      url: path,
      fetch: this.#fetch,
    });
    if (result.status === 404) return false;
    ensureGcpResponseOk(result, `clouddns:DeleteRRSet ${parts.fqdn}`);
    return true;
  }

  #packId(fqdn: string, target: string): string {
    return `${this.#zoneName}|${fqdn}|${target}`;
  }

  #unpackId(
    id: string,
  ): { fqdn: string; target: string } | undefined {
    const parts = id.split("|");
    if (parts.length !== 3) return undefined;
    return { fqdn: parts[1], target: parts[2] };
  }
}

function ensureTrailingDot(s: string): string {
  return s.endsWith(".") ? s : `${s}.`;
}
