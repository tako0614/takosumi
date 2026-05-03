import type { ManifestResource, Template } from "takosumi-contract";

export interface SelfhostedSingleVmInputs {
  readonly serviceName: string;
  readonly image: string;
  readonly port: number;
  readonly databaseVersion?: string;
  readonly assetsBucketName?: string;
  readonly domain?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export const SelfhostedSingleVmTemplate: Template<SelfhostedSingleVmInputs> = {
  id: "selfhosted-single-vm",
  version: "v1",
  description:
    "Web service + Postgres + filesystem object store + optional CoreDNS, all on a single host.",
  validateInputs(value, issues) {
    if (!isRecord(value)) {
      issues.push({ path: "$", message: "must be an object" });
      return;
    }
    if (!isNonEmptyString(value.serviceName)) {
      issues.push({
        path: "$.serviceName",
        message: "must be a non-empty string",
      });
    }
    if (!isNonEmptyString(value.image)) {
      issues.push({ path: "$.image", message: "must be a non-empty string" });
    }
    if (!isPositiveInteger(value.port)) {
      issues.push({ path: "$.port", message: "must be a positive integer" });
    }
    if (
      value.databaseVersion !== undefined &&
      !isNonEmptyString(value.databaseVersion)
    ) {
      issues.push({
        path: "$.databaseVersion",
        message: "must be a non-empty string",
      });
    }
    if (
      value.assetsBucketName !== undefined &&
      !isNonEmptyString(value.assetsBucketName)
    ) {
      issues.push({
        path: "$.assetsBucketName",
        message: "must be a non-empty string",
      });
    }
    if (value.domain !== undefined && !isNonEmptyString(value.domain)) {
      issues.push({ path: "$.domain", message: "must be a non-empty string" });
    }
  },
  expand(inputs) {
    const dbVersion = inputs.databaseVersion ?? "16";
    const assetsName = inputs.assetsBucketName ??
      `${inputs.serviceName}-assets`;
    const resources: ManifestResource[] = [
      {
        shape: "database-postgres@v1",
        name: "db",
        provider: "@takos/selfhost-postgres",
        spec: { version: dbVersion, size: "small" },
      },
      {
        shape: "object-store@v1",
        name: "assets",
        provider: "@takos/selfhost-filesystem",
        spec: { name: assetsName },
      },
      {
        shape: "web-service@v1",
        name: inputs.serviceName,
        provider: "@takos/selfhost-docker-compose",
        spec: {
          image: inputs.image,
          port: inputs.port,
          scale: { min: 1, max: 1 },
          bindings: {
            DATABASE_URL: "${ref:db.connectionString}",
            ASSETS_BUCKET: "${ref:assets.bucket}",
          },
        },
      },
    ];
    if (inputs.domain !== undefined) {
      resources.push({
        shape: "custom-domain@v1",
        name: "domain",
        provider: "@takos/selfhost-coredns",
        spec: {
          name: inputs.domain,
          target: `\${ref:${inputs.serviceName}.url}`,
        },
      });
    }
    return resources;
  },
};
