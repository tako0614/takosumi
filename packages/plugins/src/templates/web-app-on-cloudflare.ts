import type { ManifestResource, Template } from "takosumi-contract";

export interface WebAppOnCloudflareInputs {
  readonly serviceName: string;
  readonly image: string;
  readonly port: number;
  readonly domain: string;
  readonly assetsBucketName?: string;
  readonly databaseProvider?:
    | "@takos/aws-rds"
    | "@takos/gcp-cloud-sql"
    | "@takos/selfhost-postgres";
  readonly databaseVersion?: string;
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

const VALID_DB_PROVIDERS = new Set([
  "@takos/aws-rds",
  "@takos/gcp-cloud-sql",
  "@takos/selfhost-postgres",
]);

export const WebAppOnCloudflareTemplate: Template<WebAppOnCloudflareInputs> = {
  id: "web-app-on-cloudflare",
  version: "v1",
  description:
    "Cloudflare-edge web app: CF container + R2 + DNS + pluggable Postgres.",
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
    if (!isNonEmptyString(value.domain)) {
      issues.push({ path: "$.domain", message: "must be a non-empty string" });
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
    if (
      value.databaseProvider !== undefined &&
      (typeof value.databaseProvider !== "string" ||
        !VALID_DB_PROVIDERS.has(value.databaseProvider))
    ) {
      issues.push({
        path: "$.databaseProvider",
        message: `must be one of: ${Array.from(VALID_DB_PROVIDERS).join(", ")}`,
      });
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
  },
  expand(inputs) {
    const dbProvider = inputs.databaseProvider ?? "@takos/aws-rds";
    const dbVersion = inputs.databaseVersion ?? "16";
    const assetsName = inputs.assetsBucketName ??
      `${inputs.serviceName}-assets`;
    const resources: ManifestResource[] = [
      {
        shape: "database-postgres@v1",
        name: "db",
        provider: dbProvider,
        spec: { version: dbVersion, size: "small" },
      },
      {
        shape: "object-store@v1",
        name: "assets",
        provider: "@takos/cloudflare-r2",
        spec: { name: assetsName, public: false },
      },
      {
        shape: "web-service@v1",
        name: inputs.serviceName,
        provider: "@takos/cloudflare-container",
        spec: {
          image: inputs.image,
          port: inputs.port,
          scale: { min: 0, max: 10 },
          bindings: {
            DATABASE_URL: "${ref:db.connectionString}",
            ASSETS_BUCKET: "${ref:assets.bucket}",
            ASSETS_ENDPOINT: "${ref:assets.endpoint}",
          },
        },
      },
      {
        shape: "custom-domain@v1",
        name: "domain",
        provider: "@takos/cloudflare-dns",
        spec: {
          name: inputs.domain,
          target: `\${ref:${inputs.serviceName}.url}`,
        },
      },
    ];
    return resources;
  },
};
