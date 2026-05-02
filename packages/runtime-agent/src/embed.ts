/**
 * Embedded runtime-agent.
 *
 * Allows the kernel (or CLI) to spawn an in-process runtime-agent for
 * single-VM development. The kernel and agent share the same Deno process,
 * so the env vars containing cloud credentials are visible to both. A random
 * bearer token is generated and exported via `TAKOSUMI_AGENT_TOKEN` so the
 * kernel's plugin client picks it up automatically.
 *
 * For multi-host production, operators run a standalone agent (`takosumi
 * runtime-agent serve`) and set `TAKOSUMI_AGENT_URL` + `TAKOSUMI_AGENT_TOKEN`
 * explicitly — `startEmbeddedAgent` is bypassed.
 */

import { LIFECYCLE_AGENT_TOKEN_ENV, LIFECYCLE_AGENT_URL_ENV } from "takosumi-contract";
import { buildConnectorRegistry } from "./connectors/factory.ts";
import { type ServeHandle, serveRuntimeAgent } from "./server.ts";

export interface EmbedOptions {
  readonly port?: number;
  readonly hostname?: string;
  /** Override env source. Defaults to `Deno.env.toObject()`. */
  readonly env?: Record<string, string | undefined>;
  /** Override token (default: random hex). */
  readonly token?: string;
  /** When true, mutate `Deno.env` so the kernel picks up agentUrl/token automatically. */
  readonly exportToProcessEnv?: boolean;
}

export interface EmbeddedAgentHandle extends ServeHandle {
  readonly token: string;
}

export function startEmbeddedAgent(
  options: EmbedOptions = {},
): EmbeddedAgentHandle {
  const env = options.env ?? Deno.env.toObject();
  const token = options.token ?? randomToken();
  const registry = buildConnectorRegistry(detectFromEnv(env));
  const handle = serveRuntimeAgent({
    port: options.port,
    hostname: options.hostname,
    registry,
    token,
  });
  if (options.exportToProcessEnv !== false) {
    Deno.env.set(LIFECYCLE_AGENT_URL_ENV, handle.url);
    Deno.env.set(LIFECYCLE_AGENT_TOKEN_ENV, token);
  }
  return Object.freeze({ ...handle, token });
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function detectFromEnv(
  env: Record<string, string | undefined>,
): import("./connectors/factory.ts").ConnectorBootOptions {
  const aws = env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    ? {
      region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1",
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN,
    }
    : undefined;
  const gcp =
    env.GOOGLE_CLOUD_PROJECT && (env.GOOGLE_APPLICATION_CREDENTIALS || env.GCP_BEARER_TOKEN)
      ? {
        project: env.GOOGLE_CLOUD_PROJECT,
        region: env.GOOGLE_CLOUD_REGION ?? "us-central1",
        credentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS,
        bearerToken: env.GCP_BEARER_TOKEN,
      }
      : undefined;
  const cloudflare = env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID
    ? {
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      zoneId: env.CLOUDFLARE_ZONE_ID,
    }
    : undefined;
  const azure = env.AZURE_SUBSCRIPTION_ID && env.AZURE_RESOURCE_GROUP &&
      env.AZURE_BEARER_TOKEN
    ? {
      subscriptionId: env.AZURE_SUBSCRIPTION_ID,
      resourceGroup: env.AZURE_RESOURCE_GROUP,
      bearerToken: env.AZURE_BEARER_TOKEN,
      region: env.AZURE_LOCATION ?? "eastus",
    }
    : undefined;
  const kubernetes =
    env.TAKOSUMI_KUBERNETES_API_SERVER_URL && env.TAKOSUMI_KUBERNETES_BEARER_TOKEN
      ? {
        apiServerUrl: env.TAKOSUMI_KUBERNETES_API_SERVER_URL,
        bearerToken: env.TAKOSUMI_KUBERNETES_BEARER_TOKEN,
        namespace: env.TAKOSUMI_KUBERNETES_NAMESPACE ?? "takosumi",
      }
      : undefined;
  const selfhost = {
    filesystemRoot: env.TAKOSUMI_SELFHOSTED_OBJECT_STORE_ROOT,
    dockerSocket: env.TAKOSUMI_SELFHOSTED_DOCKER_SOCKET,
    systemdUnitDir: env.TAKOSUMI_SELFHOSTED_SYSTEMD_UNIT_DIR,
    minioEndpoint: env.TAKOSUMI_SELFHOSTED_OBJECT_STORE_ENDPOINT,
    corednsFile: env.TAKOSUMI_SELFHOSTED_COREDNS_FILE,
    postgresHost: env.TAKOSUMI_SELFHOSTED_POSTGRES_HOST,
  };
  return { aws, gcp, cloudflare, azure, kubernetes, selfhost };
}
