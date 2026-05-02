/**
 * `DirectAwsRdsLifecycle` — calls AWS RDS REST API directly via SigV4-signed
 * fetch. RDS uses the Query API (form-urlencoded body, XML response).
 */

import {
  type AwsSigV4Credentials,
  ensureAwsResponseOk,
  sigv4Fetch,
} from "../../_aws_sigv4.ts";
import { findFirstText, parseXml, type XmlNode } from "../../_xml.ts";

export interface AwsRdsInstanceDescriptor {
  readonly instanceId: string;
  readonly endpoint: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly version: string;
  readonly arn: string;
}

export interface AwsRdsCreateInstanceInput {
  readonly instanceId: string;
  readonly engineVersion: string;
  readonly instanceClass: string;
  readonly allocatedStorageGb: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly multiAz: boolean;
}

export interface DirectAwsRdsLifecycleOptions {
  readonly credentials: AwsSigV4Credentials;
  readonly region: string;
  readonly subnetGroupName?: string;
  readonly securityGroupIds?: readonly string[];
  readonly fetch?: typeof fetch;
}

export class DirectAwsRdsLifecycle {
  readonly #opts: DirectAwsRdsLifecycleOptions;

  constructor(options: DirectAwsRdsLifecycleOptions) {
    this.#opts = options;
  }

  async createInstance(
    input: AwsRdsCreateInstanceInput,
  ): Promise<AwsRdsInstanceDescriptor> {
    const params: Record<string, string> = {
      "Action": "CreateDBInstance",
      "Version": "2014-10-31",
      "DBInstanceIdentifier": input.instanceId,
      "Engine": "postgres",
      "EngineVersion": input.engineVersion,
      "DBInstanceClass": input.instanceClass,
      "AllocatedStorage": String(input.allocatedStorageGb),
      "DBName": input.database,
      "MasterUsername": input.username,
      "MasterUserPassword": input.password,
      "MultiAZ": String(input.multiAz),
      "PubliclyAccessible": "false",
      "BackupRetentionPeriod": "7",
      "StorageType": "gp3",
    };
    if (this.#opts.subnetGroupName) {
      params["DBSubnetGroupName"] = this.#opts.subnetGroupName;
    }
    if (this.#opts.securityGroupIds) {
      this.#opts.securityGroupIds.forEach((id, idx) => {
        params[`VpcSecurityGroupIds.member.${idx + 1}`] = id;
      });
    }
    const xmlText = await this.#callRds(params);
    const root = parseXml(xmlText);
    const endpoint = findFirstText(root, "Endpoint.Address") ??
      `${input.instanceId}.${this.#opts.region}.rds.amazonaws.com`;
    const port = parsePort(findFirstText(root, "Endpoint.Port"));
    return {
      instanceId: input.instanceId,
      endpoint,
      port,
      database: input.database,
      username: input.username,
      version: input.engineVersion,
      arn: findFirstText(root, "DBInstanceArn") ??
        `arn:aws:rds:${this.#opts.region}::db:${input.instanceId}`,
    };
  }

  async describeInstance(
    input: { readonly instanceId: string },
  ): Promise<AwsRdsInstanceDescriptor | undefined> {
    try {
      const xmlText = await this.#callRds({
        "Action": "DescribeDBInstances",
        "Version": "2014-10-31",
        "DBInstanceIdentifier": input.instanceId,
      });
      const root = parseXml(xmlText);
      const endpoint = findFirstText(root, "Endpoint.Address");
      if (!endpoint) return undefined;
      return {
        instanceId: input.instanceId,
        endpoint,
        port: parsePort(findFirstText(root, "Endpoint.Port")),
        database: findFirstText(root, "DBName") ?? "app",
        username: findFirstText(root, "MasterUsername") ?? "app",
        version: findFirstText(root, "EngineVersion") ?? "16",
        arn: findFirstText(root, "DBInstanceArn") ??
          `arn:aws:rds:${this.#opts.region}::db:${input.instanceId}`,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        /DBInstanceNotFound/.test(error.message)
      ) return undefined;
      throw error;
    }
  }

  async deleteInstance(
    input: { readonly instanceId: string },
  ): Promise<boolean> {
    try {
      await this.#callRds({
        "Action": "DeleteDBInstance",
        "Version": "2014-10-31",
        "DBInstanceIdentifier": input.instanceId,
        "SkipFinalSnapshot": "true",
        "DeleteAutomatedBackups": "true",
      });
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        /DBInstanceNotFound/.test(error.message)
      ) return false;
      throw error;
    }
  }

  async #callRds(params: Record<string, string>): Promise<string> {
    const body = new URLSearchParams(params).toString();
    const response = await sigv4Fetch(
      {
        method: "POST",
        url: `https://rds.${this.#opts.region}.amazonaws.com/`,
        service: "rds",
        region: this.#opts.region,
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body,
      },
      {
        credentials: this.#opts.credentials,
        fetch: this.#opts.fetch,
      },
    );
    await ensureAwsResponseOk(response, `rds:${params.Action}`);
    return await response.text();
  }
}

function parsePort(value: string | undefined): number {
  if (!value) return 5432;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 5432;
}

export type { XmlNode };
