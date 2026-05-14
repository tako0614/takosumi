/**
 * `DirectCloudflareContainerLifecycle` — drives Cloudflare Containers via the
 * REST API.
 */

import {
  cfFetch,
  cfFetchValidated,
  ensureCfOk,
} from "../../_cloudflare_api.ts";
import { parseCloudflareContainerResult } from "../_wire.ts";

export interface CloudflareContainerDescriptor {
  readonly accountId: string;
  readonly serviceName: string;
  readonly publicUrl: string;
  readonly internalHost: string;
  readonly port: number;
}

export interface CloudflareContainerCreateInput {
  readonly serviceName: string;
  readonly image: string;
  readonly minInstances: number;
  readonly maxInstances: number;
  readonly port: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface DirectCloudflareContainerLifecycleOptions {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
}

export class DirectCloudflareContainerLifecycle {
  readonly #accountId: string;
  readonly #apiToken: string;
  readonly #fetch?: typeof fetch;

  constructor(options: DirectCloudflareContainerLifecycleOptions) {
    this.#accountId = options.accountId;
    this.#apiToken = options.apiToken;
    this.#fetch = options.fetch;
  }

  async createService(
    input: CloudflareContainerCreateInput,
  ): Promise<CloudflareContainerDescriptor> {
    const body = {
      name: input.serviceName,
      image: input.image,
      port: input.port,
      env: input.env ?? {},
      instances: { min: input.minInstances, max: input.maxInstances },
    };
    const context = `cf-containers:CreateApplication ${input.serviceName}`;
    const result = await cfFetchValidated(
      {
        method: "POST",
        path: `/accounts/${this.#accountId}/containers/applications`,
        body,
      },
      { apiToken: this.#apiToken, fetch: this.#fetch },
      parseCloudflareContainerResult,
      context,
    );
    if (result.status !== 409) {
      ensureCfOk(result, context);
    }
    let publicUrl = result.envelope?.result?.url;
    if (!publicUrl) {
      const existing = await this.describeService({
        serviceName: input.serviceName,
      });
      if (existing) publicUrl = existing.publicUrl;
    }
    if (!publicUrl) {
      throw new Error(
        `cf-containers:CreateApplication ${input.serviceName}: API response ` +
          `did not expose a public URL; refusing to fabricate one. The ` +
          `Cloudflare Container application may still be provisioning.`,
      );
    }
    return {
      accountId: this.#accountId,
      serviceName: input.serviceName,
      publicUrl,
      internalHost: `${input.serviceName}.cf.local`,
      port: input.port,
    };
  }

  async describeService(
    input: { readonly serviceName: string },
  ): Promise<CloudflareContainerDescriptor | undefined> {
    const context = `cf-containers:GetApplication ${input.serviceName}`;
    const result = await cfFetchValidated(
      {
        method: "GET",
        path:
          `/accounts/${this.#accountId}/containers/applications/${input.serviceName}`,
      },
      { apiToken: this.#apiToken, fetch: this.#fetch },
      parseCloudflareContainerResult,
      context,
    );
    if (result.status === 404) return undefined;
    ensureCfOk(result, context);
    const publicUrl = result.envelope?.result?.url;
    if (!publicUrl) {
      throw new Error(
        `${context}: API response did not include a public URL; ` +
          `refusing to fabricate one.`,
      );
    }
    return {
      accountId: this.#accountId,
      serviceName: input.serviceName,
      publicUrl,
      internalHost: `${input.serviceName}.cf.local`,
      port: result.envelope?.result?.port ?? 0,
    };
  }

  /**
   * Verify-only: list container applications for the account. 200 / 404
   * both indicate the credentials are accepted (404 = beta API not
   * enabled / no applications yet). Returns raw status / text.
   */
  listApplicationsResult(): Promise<
    { status: number; ok: boolean; text: string }
  > {
    return cfFetch(
      {
        method: "GET",
        path: `/accounts/${this.#accountId}/containers/applications`,
      },
      { apiToken: this.#apiToken, fetch: this.#fetch },
    ).then((result) => ({
      status: result.status,
      ok: result.envelope?.success === true && result.status >= 200 &&
        result.status < 300,
      text: result.text,
    }));
  }

  async deleteService(
    input: { readonly serviceName: string },
  ): Promise<boolean> {
    const result = await cfFetch(
      {
        method: "DELETE",
        path:
          `/accounts/${this.#accountId}/containers/applications/${input.serviceName}`,
      },
      { apiToken: this.#apiToken, fetch: this.#fetch },
    );
    if (result.status === 404) return false;
    ensureCfOk(
      result,
      `cf-containers:DeleteApplication ${input.serviceName}`,
    );
    return true;
  }
}
