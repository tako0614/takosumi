/**
 * `DirectRoute53Lifecycle` — calls AWS Route 53 REST API directly via SigV4
 * fetch. Route 53 is a global service (region `us-east-1` for signing).
 */

import {
  type AwsSigV4Credentials,
  ensureAwsResponseOk,
  sigv4Fetch,
} from "../../_aws_sigv4.ts";

export interface Route53RecordDescriptor {
  readonly recordSetId: string;
  readonly fqdn: string;
  readonly target: string;
  readonly hostedZoneId: string;
  readonly certificateArn?: string;
}

export interface Route53CreateRecordInput {
  readonly fqdn: string;
  readonly target: string;
  readonly recordType: "A" | "AAAA" | "CNAME";
}

export interface DirectRoute53LifecycleOptions {
  readonly credentials: AwsSigV4Credentials;
  readonly hostedZoneId: string;
  readonly ttlSeconds?: number;
  readonly fetch?: typeof fetch;
}

const ROUTE53_REGION = "us-east-1";

export class DirectRoute53Lifecycle {
  readonly #opts: DirectRoute53LifecycleOptions;

  constructor(options: DirectRoute53LifecycleOptions) {
    this.#opts = options;
  }

  async createRecord(
    input: Route53CreateRecordInput,
  ): Promise<Route53RecordDescriptor> {
    await this.#changeRecordSet(
      input.fqdn,
      input.recordType,
      input.target,
      "UPSERT",
    );
    return {
      recordSetId: this.#packId(input.fqdn, input.recordType, input.target),
      fqdn: input.fqdn,
      target: input.target,
      hostedZoneId: this.#opts.hostedZoneId,
    };
  }

  describeRecord(
    input: { readonly recordSetId: string },
  ): Promise<Route53RecordDescriptor | undefined> {
    const parts = this.#unpackId(input.recordSetId);
    if (!parts) return Promise.resolve(undefined);
    return Promise.resolve({
      recordSetId: input.recordSetId,
      fqdn: parts.fqdn,
      target: parts.target,
      hostedZoneId: this.#opts.hostedZoneId,
    });
  }

  async deleteRecord(
    input: { readonly recordSetId: string },
  ): Promise<boolean> {
    const parts = this.#unpackId(input.recordSetId);
    if (!parts) return false;
    try {
      await this.#changeRecordSet(
        parts.fqdn,
        parts.type,
        parts.target,
        "DELETE",
      );
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        /InvalidChangeBatch|NoSuchHostedZone|NotFound/.test(error.message)
      ) return false;
      throw error;
    }
  }

  async #changeRecordSet(
    fqdn: string,
    type: string,
    target: string,
    action: "UPSERT" | "DELETE",
  ): Promise<void> {
    const ttl = this.#opts.ttlSeconds ?? 300;
    const body = `<?xml version="1.0" encoding="UTF-8"?>` +
      `<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">` +
      `<ChangeBatch><Changes><Change>` +
      `<Action>${action}</Action>` +
      `<ResourceRecordSet>` +
      `<Name>${escapeXml(fqdn)}</Name>` +
      `<Type>${type}</Type>` +
      `<TTL>${ttl}</TTL>` +
      `<ResourceRecords><ResourceRecord><Value>${
        escapeXml(target)
      }</Value></ResourceRecord></ResourceRecords>` +
      `</ResourceRecordSet>` +
      `</Change></Changes></ChangeBatch>` +
      `</ChangeResourceRecordSetsRequest>`;
    const response = await sigv4Fetch(
      {
        method: "POST",
        url:
          `https://route53.amazonaws.com/2013-04-01/hostedzone/${this.#opts.hostedZoneId}/rrset`,
        service: "route53",
        region: ROUTE53_REGION,
        headers: { "content-type": "application/xml" },
        body,
      },
      {
        credentials: this.#opts.credentials,
        fetch: this.#opts.fetch,
      },
    );
    await ensureAwsResponseOk(
      response,
      `route53:ChangeResourceRecordSets ${action} ${fqdn}`,
    );
  }

  #packId(fqdn: string, type: string, target: string): string {
    return `${this.#opts.hostedZoneId}|${type}|${fqdn}|${target}`;
  }

  #unpackId(
    id: string,
  ): { fqdn: string; type: string; target: string } | undefined {
    const parts = id.split("|");
    if (parts.length !== 4) return undefined;
    return { type: parts[1], fqdn: parts[2], target: parts[3] };
  }
}

function escapeXml(str: string): string {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
