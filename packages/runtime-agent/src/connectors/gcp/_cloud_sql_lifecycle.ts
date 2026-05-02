/**
 * `DirectCloudSqlLifecycle` — calls GCP Cloud SQL Admin REST API directly.
 *
 * Endpoint: https://sqladmin.googleapis.com/v1/projects/{p}/instances
 */

import {
  ensureGcpResponseOk,
  GcpAccessTokenProvider,
  type GcpAccessTokenProviderOptions,
  gcpJsonFetch,
} from "../../_gcp_auth.ts";

export interface CloudSqlInstanceDescriptor {
  readonly instanceName: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly version: string;
  readonly project: string;
  readonly region: string;
  readonly resourceName: string;
}

export interface CloudSqlCreateInstanceInput {
  readonly instanceName: string;
  readonly engineVersion: string;
  readonly tier: string;
  readonly storageSizeGb: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly highAvailability: boolean;
}

export interface DirectCloudSqlLifecycleOptions
  extends GcpAccessTokenProviderOptions {
  readonly project: string;
  readonly region: string;
}

export class DirectCloudSqlLifecycle {
  readonly #project: string;
  readonly #region: string;
  readonly #tokens: GcpAccessTokenProvider;
  readonly #fetch?: typeof fetch;

  constructor(options: DirectCloudSqlLifecycleOptions) {
    this.#project = options.project;
    this.#region = options.region;
    this.#tokens = new GcpAccessTokenProvider(options);
    this.#fetch = options.fetch;
  }

  async createInstance(
    input: CloudSqlCreateInstanceInput,
  ): Promise<CloudSqlInstanceDescriptor> {
    const body = {
      name: input.instanceName,
      databaseVersion: input.engineVersion,
      region: this.#region,
      rootPassword: input.password,
      settings: {
        tier: input.tier,
        dataDiskSizeGb: String(input.storageSizeGb),
        availabilityType: input.highAvailability ? "REGIONAL" : "ZONAL",
        backupConfiguration: {
          enabled: true,
          pointInTimeRecoveryEnabled: true,
        },
        ipConfiguration: {
          ipv4Enabled: false,
          requireSsl: true,
        },
      },
    };
    const result = await gcpJsonFetch<{
      name?: string;
      ipAddresses?: { ipAddress?: string; type?: string }[];
    }>(
      this.#tokens,
      {
        method: "POST",
        url:
          `https://sqladmin.googleapis.com/v1/projects/${this.#project}/instances`,
        body,
        fetch: this.#fetch,
      },
    );
    if (result.status === 409) {
      // Already exists; idempotent
    } else {
      ensureGcpResponseOk(
        result,
        `cloudsql:InstancesInsert ${input.instanceName}`,
      );
    }
    return this.#descriptor(
      input.instanceName,
      input,
      result.json?.ipAddresses,
    );
  }

  async describeInstance(
    input: { readonly instanceName: string },
  ): Promise<CloudSqlInstanceDescriptor | undefined> {
    const result = await gcpJsonFetch<{
      databaseVersion?: string;
      ipAddresses?: { ipAddress?: string; type?: string }[];
    }>(this.#tokens, {
      method: "GET",
      url:
        `https://sqladmin.googleapis.com/v1/projects/${this.#project}/instances/${
          encodeURIComponent(input.instanceName)
        }`,
      fetch: this.#fetch,
    });
    if (result.status === 404) return undefined;
    ensureGcpResponseOk(
      result,
      `cloudsql:InstancesGet ${input.instanceName}`,
    );
    return this.#descriptor(
      input.instanceName,
      {
        engineVersion: result.json?.databaseVersion ?? "POSTGRES_16",
        database: "app",
        username: "app",
      },
      result.json?.ipAddresses,
    );
  }

  async deleteInstance(
    input: { readonly instanceName: string },
  ): Promise<boolean> {
    const result = await gcpJsonFetch(this.#tokens, {
      method: "DELETE",
      url:
        `https://sqladmin.googleapis.com/v1/projects/${this.#project}/instances/${
          encodeURIComponent(input.instanceName)
        }`,
      fetch: this.#fetch,
    });
    if (result.status === 404) return false;
    ensureGcpResponseOk(
      result,
      `cloudsql:InstancesDelete ${input.instanceName}`,
    );
    return true;
  }

  #descriptor(
    instanceName: string,
    seed: { engineVersion: string; database: string; username: string },
    ipAddresses: readonly { ipAddress?: string; type?: string }[] | undefined,
  ): CloudSqlInstanceDescriptor {
    const ip = ipAddresses?.find((entry) => entry.type === "PRIMARY")
      ?.ipAddress ??
      `${instanceName}.${this.#project}.${this.#region}.cloudsql`;
    return {
      instanceName,
      host: ip,
      port: 5432,
      database: seed.database,
      username: seed.username,
      version: seed.engineVersion,
      project: this.#project,
      region: this.#region,
      resourceName: `projects/${this.#project}/instances/${instanceName}`,
    };
  }
}
