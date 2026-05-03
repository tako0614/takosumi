/**
 * `buildConnectorRegistry` — wires per-cloud / selfhost connectors into a
 * `ConnectorRegistry` based on operator-supplied credentials.
 *
 * Empty `opts` returns a registry containing only the always-available
 * selfhost connectors (filesystem rooted at `/var/lib/takosumi/objects`,
 * docker-compose / systemd / minio / coredns-local with default endpoints,
 * local-docker postgres).
 */

import { ConnectorRegistry } from "./connector.ts";
import { AwsFargateConnector } from "./aws/fargate.ts";
import { AwsRdsConnector } from "./aws/rds.ts";
import { AwsS3Connector } from "./aws/s3.ts";
import { Route53Connector } from "./aws/route53.ts";
import { CloudDnsConnector } from "./gcp/cloud_dns.ts";
import { CloudRunConnector } from "./gcp/cloud_run.ts";
import { CloudSqlConnector } from "./gcp/cloud_sql.ts";
import { GcpGcsConnector } from "./gcp/gcs.ts";
import { CloudflareContainerConnector } from "./cloudflare/container.ts";
import { CloudflareDnsConnector } from "./cloudflare/dns.ts";
import { CloudflareR2Connector } from "./cloudflare/r2.ts";
import { CloudflareWorkersConnector } from "./cloudflare/workers.ts";
import { DenoDeployWorkersConnector } from "./deno_deploy/workers.ts";
import { AzureContainerAppsConnector } from "./azure/container_apps.ts";
import { K3sDeploymentConnector } from "./kubernetes/k3s_deployment.ts";
import { CorednsLocalConnector } from "./selfhost/coredns_local.ts";
import { DockerComposeConnector } from "./selfhost/docker_compose.ts";
import { FilesystemConnector } from "./selfhost/filesystem.ts";
import { LocalDockerPostgresConnector } from "./selfhost/local_docker_postgres.ts";
import { MinioConnector } from "./selfhost/minio.ts";
import { SystemdUnitConnector } from "./selfhost/systemd_unit.ts";

export interface ConnectorBootOptions {
  readonly aws?: {
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
    readonly fargateClusterName?: string;
    readonly fargateSubnetIds?: readonly string[];
    readonly fargateSecurityGroupIds?: readonly string[];
    readonly fargateExecutionRoleArn?: string;
    readonly fargateTaskRoleArn?: string;
    readonly fargateAssignPublicIp?: boolean;
    readonly route53HostedZoneId?: string;
    readonly rdsSubnetGroupName?: string;
    readonly rdsSecurityGroupIds?: readonly string[];
  };
  readonly gcp?: {
    readonly project: string;
    readonly region: string;
    readonly bearerToken?: string;
    readonly serviceAccountKey?: string;
    readonly cloudDnsZoneName?: string;
  };
  readonly cloudflare?: {
    readonly accountId: string;
    readonly apiToken: string;
    readonly zoneId?: string;
  };
  readonly denoDeploy?: {
    readonly accessToken: string;
    readonly organizationId?: string;
  };
  readonly azure?: {
    readonly subscriptionId: string;
    readonly resourceGroup: string;
    readonly bearerToken: string;
    readonly region?: string;
    readonly environmentName?: string;
    readonly environmentResourceId?: string;
  };
  readonly kubernetes?: {
    readonly apiServerUrl: string;
    readonly bearerToken: string;
    readonly namespace?: string;
    readonly clusterDomain?: string;
  };
  readonly selfhost?: {
    readonly filesystemRoot?: string;
    readonly dockerHostBinding?: string;
    readonly systemdUnitDir?: string;
    readonly minioEndpoint?: string;
    readonly corednsZoneFile?: string;
    readonly postgresHostBinding?: string;
  };
}

export function buildConnectorRegistry(
  opts: ConnectorBootOptions = {},
): ConnectorRegistry {
  const reg = new ConnectorRegistry();

  if (opts.aws) {
    const credentials = {
      accessKeyId: opts.aws.accessKeyId,
      secretAccessKey: opts.aws.secretAccessKey,
      sessionToken: opts.aws.sessionToken,
    };
    reg.register(
      new AwsS3Connector({ region: opts.aws.region, credentials }),
    );
    reg.register(
      new AwsFargateConnector({
        region: opts.aws.region,
        credentials,
        clusterName: opts.aws.fargateClusterName ?? "takos",
        subnetIds: opts.aws.fargateSubnetIds ?? [],
        securityGroupIds: opts.aws.fargateSecurityGroupIds,
        executionRoleArn: opts.aws.fargateExecutionRoleArn,
        taskRoleArn: opts.aws.fargateTaskRoleArn,
        assignPublicIp: opts.aws.fargateAssignPublicIp,
      }),
    );
    reg.register(
      new AwsRdsConnector({
        region: opts.aws.region,
        credentials,
        subnetGroupName: opts.aws.rdsSubnetGroupName,
        securityGroupIds: opts.aws.rdsSecurityGroupIds,
      }),
    );
    if (opts.aws.route53HostedZoneId) {
      reg.register(
        new Route53Connector({
          credentials,
          hostedZoneId: opts.aws.route53HostedZoneId,
        }),
      );
    }
  }

  if (opts.gcp) {
    reg.register(
      new GcpGcsConnector({
        project: opts.gcp.project,
        defaultLocation: opts.gcp.region,
        bearerToken: opts.gcp.bearerToken,
        serviceAccountKey: opts.gcp.serviceAccountKey,
      }),
    );
    reg.register(
      new CloudRunConnector({
        project: opts.gcp.project,
        region: opts.gcp.region,
        bearerToken: opts.gcp.bearerToken,
        serviceAccountKey: opts.gcp.serviceAccountKey,
      }),
    );
    reg.register(
      new CloudSqlConnector({
        project: opts.gcp.project,
        region: opts.gcp.region,
        bearerToken: opts.gcp.bearerToken,
        serviceAccountKey: opts.gcp.serviceAccountKey,
      }),
    );
    if (opts.gcp.cloudDnsZoneName) {
      reg.register(
        new CloudDnsConnector({
          project: opts.gcp.project,
          zoneName: opts.gcp.cloudDnsZoneName,
          bearerToken: opts.gcp.bearerToken,
          serviceAccountKey: opts.gcp.serviceAccountKey,
        }),
      );
    }
  }

  if (opts.cloudflare) {
    reg.register(
      new CloudflareR2Connector({
        accountId: opts.cloudflare.accountId,
        apiToken: opts.cloudflare.apiToken,
      }),
    );
    reg.register(
      new CloudflareContainerConnector({
        accountId: opts.cloudflare.accountId,
        apiToken: opts.cloudflare.apiToken,
      }),
    );
    reg.register(
      new CloudflareWorkersConnector({
        accountId: opts.cloudflare.accountId,
        apiToken: opts.cloudflare.apiToken,
      }),
    );
    if (opts.cloudflare.zoneId) {
      reg.register(
        new CloudflareDnsConnector({
          zoneId: opts.cloudflare.zoneId,
          apiToken: opts.cloudflare.apiToken,
        }),
      );
    }
  }

  if (opts.denoDeploy) {
    reg.register(
      new DenoDeployWorkersConnector({
        accessToken: opts.denoDeploy.accessToken,
        organizationId: opts.denoDeploy.organizationId,
      }),
    );
  }

  if (opts.azure) {
    const region = opts.azure.region ?? "eastus";
    const environmentName = opts.azure.environmentName ?? "takosumi";
    const environmentResourceId = opts.azure.environmentResourceId ??
      `/subscriptions/${opts.azure.subscriptionId}/resourceGroups/${opts.azure.resourceGroup}/providers/Microsoft.App/managedEnvironments/${environmentName}`;
    reg.register(
      new AzureContainerAppsConnector({
        subscriptionId: opts.azure.subscriptionId,
        resourceGroup: opts.azure.resourceGroup,
        region,
        environmentName,
        environmentResourceId,
        bearerToken: opts.azure.bearerToken,
      }),
    );
  }

  if (opts.kubernetes) {
    reg.register(
      new K3sDeploymentConnector({
        apiServerUrl: opts.kubernetes.apiServerUrl,
        bearerToken: opts.kubernetes.bearerToken,
        namespace: opts.kubernetes.namespace ?? "takos",
        clusterDomain: opts.kubernetes.clusterDomain,
      }),
    );
  }

  // Selfhost connectors are always registered with reasonable defaults.
  reg.register(
    new FilesystemConnector({
      rootDir: opts.selfhost?.filesystemRoot ?? "/var/lib/takosumi/objects",
    }),
  );
  reg.register(
    new DockerComposeConnector({
      hostBinding: opts.selfhost?.dockerHostBinding,
    }),
  );
  reg.register(
    new SystemdUnitConnector({
      unitDir: opts.selfhost?.systemdUnitDir,
    }),
  );
  reg.register(
    new MinioConnector({
      endpoint: opts.selfhost?.minioEndpoint ?? "http://minio.local:9000",
    }),
  );
  reg.register(
    new CorednsLocalConnector({
      zoneFile: opts.selfhost?.corednsZoneFile ?? "/etc/coredns/Corefile",
    }),
  );
  reg.register(
    new LocalDockerPostgresConnector({
      hostBinding: opts.selfhost?.postgresHostBinding,
    }),
  );

  return reg;
}
