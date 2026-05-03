/**
 * `DirectCloudRunLifecycle` — calls GCP Cloud Run Admin REST API directly.
 *
 * Endpoint: https://run.googleapis.com/v2/projects/{p}/locations/{r}/services
 */

import {
  ensureGcpResponseOk,
  GcpAccessTokenProvider,
  type GcpAccessTokenProviderOptions,
  gcpJsonFetch,
} from "../../_gcp_auth.ts";

export interface CloudRunServiceDescriptor {
  readonly serviceName: string;
  readonly project: string;
  readonly region: string;
  readonly url: string;
  readonly internalHost: string;
  readonly port: number;
}

export interface CloudRunCreateServiceInput {
  readonly serviceName: string;
  readonly image: string;
  readonly minInstances: number;
  readonly maxInstances: number;
  readonly cpu?: string;
  readonly memory?: string;
  readonly port: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface DirectCloudRunLifecycleOptions
  extends GcpAccessTokenProviderOptions {
  readonly project: string;
  readonly region: string;
}

export class DirectCloudRunLifecycle {
  readonly #project: string;
  readonly #region: string;
  readonly #tokens: GcpAccessTokenProvider;
  readonly #fetch?: typeof fetch;

  constructor(options: DirectCloudRunLifecycleOptions) {
    this.#project = options.project;
    this.#region = options.region;
    this.#tokens = new GcpAccessTokenProvider(options);
    this.#fetch = options.fetch;
  }

  async createService(
    input: CloudRunCreateServiceInput,
  ): Promise<CloudRunServiceDescriptor> {
    const body = {
      template: {
        scaling: {
          minInstanceCount: input.minInstances,
          maxInstanceCount: input.maxInstances,
        },
        containers: [
          {
            image: input.image,
            ports: [{ containerPort: input.port }],
            resources: {
              limits: {
                cpu: input.cpu ?? "1",
                memory: input.memory ?? "512Mi",
              },
            },
            env: input.env
              ? Object.entries(input.env).map(([name, value]) => ({
                name,
                value,
              }))
              : undefined,
          },
        ],
      },
      ingress: "INGRESS_TRAFFIC_ALL",
    };
    const result = await gcpJsonFetch<{ name?: string; uri?: string }>(
      this.#tokens,
      {
        method: "POST",
        url:
          `https://run.googleapis.com/v2/projects/${this.#project}/locations/${this.#region}/services?serviceId=${
            encodeURIComponent(input.serviceName)
          }`,
        body,
        fetch: this.#fetch,
      },
    );
    if (result.status === 409) {
      // existing — fall through to GET below
    } else {
      ensureGcpResponseOk(
        result,
        `cloudrun:CreateService ${input.serviceName}`,
      );
    }
    let uri = result.json?.uri;
    if (!uri) {
      const existing = await this.describeService({
        serviceName: input.serviceName,
      });
      if (existing) uri = existing.url;
    }
    if (!uri) {
      throw new Error(
        `cloudrun:CreateService ${input.serviceName}: API response did not ` +
          `expose service URI; cannot derive output url. The Cloud Run ` +
          `service may still be provisioning — retry once it reaches Ready.`,
      );
    }
    return {
      serviceName: input.serviceName,
      project: this.#project,
      region: this.#region,
      url: uri,
      internalHost:
        `${input.serviceName}.${this.#region}.${this.#project}.run.internal`,
      port: input.port,
    };
  }

  async describeService(
    input: { readonly serviceName: string },
  ): Promise<CloudRunServiceDescriptor | undefined> {
    const result = await gcpJsonFetch<
      {
        uri?: string;
        template?: {
          containers?: Array<{ ports?: Array<{ containerPort?: number }> }>;
        };
      }
    >(this.#tokens, {
      method: "GET",
      url:
        `https://run.googleapis.com/v2/projects/${this.#project}/locations/${this.#region}/services/${
          encodeURIComponent(input.serviceName)
        }`,
      fetch: this.#fetch,
    });
    if (result.status === 404) return undefined;
    ensureGcpResponseOk(
      result,
      `cloudrun:GetService ${input.serviceName}`,
    );
    const uri = result.json?.uri;
    if (!uri) {
      throw new Error(
        `cloudrun:GetService ${input.serviceName}: API response did not ` +
          `expose service URI; refusing to fabricate a Cloud Run URL.`,
      );
    }
    const observedPort = result.json?.template?.containers?.[0]?.ports?.[0]
      ?.containerPort ?? 8080;
    return {
      serviceName: input.serviceName,
      project: this.#project,
      region: this.#region,
      url: uri,
      internalHost:
        `${input.serviceName}.${this.#region}.${this.#project}.run.internal`,
      port: observedPort,
    };
  }

  /**
   * Verify-only: list Cloud Run services in the configured region. Returns
   * raw status / text so the connector can produce a `ConnectorVerifyResult`
   * without throwing.
   */
  listServicesResult(): Promise<
    { status: number; ok: boolean; text: string }
  > {
    return gcpJsonFetch(this.#tokens, {
      method: "GET",
      url:
        `https://run.googleapis.com/v2/projects/${this.#project}/locations/${this.#region}/services?pageSize=1`,
      fetch: this.#fetch,
    }).then((result) => ({
      status: result.status,
      ok: result.ok,
      text: result.text,
    }));
  }

  async deleteService(
    input: { readonly serviceName: string },
  ): Promise<boolean> {
    const result = await gcpJsonFetch(this.#tokens, {
      method: "DELETE",
      url:
        `https://run.googleapis.com/v2/projects/${this.#project}/locations/${this.#region}/services/${
          encodeURIComponent(input.serviceName)
        }`,
      fetch: this.#fetch,
    });
    if (result.status === 404) return false;
    ensureGcpResponseOk(result, `cloudrun:DeleteService ${input.serviceName}`);
    return true;
  }
}
