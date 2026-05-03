// core_plan — descriptor-conformance metadata only.
//
// Canonical resolution / planning / apply work lives in
// `deployment_service.ts`. This module exposes the official
// descriptor-conformance dataset consumed by docs-validation scripts and
// `core_conformance_test.ts`.

import { createHash } from "node:crypto";
import type { JsonObject } from "takosumi-contract";

const TAKOSUMI_CONTEXT_ID = "https://takosumi.com/contexts/deploy.jsonld";
const PUBLIC_MANIFEST_EXPANSION_DESCRIPTOR =
  "authoring.public-manifest-expansion@v1";
const PACKAGED_DESCRIPTOR_ROOT_URL = new URL("./", import.meta.url);
const DOCS_DESCRIPTOR_ROOT_URL = new URL(
  "../../../../../../docs/takosumi/",
  import.meta.url,
);

interface OfficialDescriptor {
  readonly id: string;
  readonly alias: string;
  readonly documentPath?: string;
  readonly lifecycleDomain?: string;
  readonly changeEffects?: readonly { path: string; effect: string }[];
  readonly body: JsonObject;
}

export interface OfficialDescriptorConformanceRecord {
  readonly id: string;
  readonly alias: string;
  readonly documentPath: string;
  readonly body: JsonObject;
  readonly digest: string;
}

const DOC_DESCRIPTOR_SOURCES: readonly { alias: string; path: string }[] = [
  {
    alias: "authoring.composite-expansion@v1",
    path: "descriptors/authoring/composite-expansion-v1.jsonld",
  },
  {
    alias: PUBLIC_MANIFEST_EXPANSION_DESCRIPTOR,
    path: "descriptors/authoring/public-manifest-expansion-v1.jsonld",
  },
  {
    alias: "composite.serverless-with-postgres@v1",
    path: "descriptors/composites/composite-serverless-with-postgres-v1.jsonld",
  },
  {
    alias: "composite.web-app-with-cdn@v1",
    path: "descriptors/composites/composite-web-app-with-cdn-v1.jsonld",
  },
  {
    alias: "artifact.js-module@v1",
    path: "descriptors/contracts/artifact-js-module-v1.jsonld",
  },
  {
    alias: "artifact.oci-image@v1",
    path: "descriptors/contracts/artifact-oci-image-v1.jsonld",
  },
  {
    alias: "interface.http@v1",
    path: "descriptors/contracts/interface-http-v1.jsonld",
  },
  {
    alias: "interface.tcp@v1",
    path: "descriptors/contracts/interface-tcp-v1.jsonld",
  },
  {
    alias: "interface.udp@v1",
    path: "descriptors/contracts/interface-udp-v1.jsonld",
  },
  {
    alias: "interface.queue@v1",
    path: "descriptors/contracts/interface-queue-v1.jsonld",
  },
  {
    alias: "interface.schedule@v1",
    path: "descriptors/contracts/interface-schedule-v1.jsonld",
  },
  {
    alias: "interface.event@v1",
    path: "descriptors/contracts/interface-event-v1.jsonld",
  },
  {
    alias: "output.http-endpoint@v1",
    path: "descriptors/contracts/output-http-endpoint-v1.jsonld",
  },
  {
    alias: "output.mcp-server@v1",
    path: "descriptors/contracts/output-mcp-server-v1.jsonld",
  },
  {
    alias: "output.topic@v1",
    path: "descriptors/contracts/output-topic-v1.jsonld",
  },
  {
    alias: "resource.object-store.s3@v1",
    path: "descriptors/contracts/resource-object-store-s3-v1.jsonld",
  },
  {
    alias: "resource.key-value@v1",
    path: "descriptors/contracts/resource-key-value-v1.jsonld",
  },
  {
    alias: "resource.queue.at-least-once@v1",
    path: "descriptors/contracts/resource-queue-at-least-once-v1.jsonld",
  },
  {
    alias: "resource.secret@v1",
    path: "descriptors/contracts/resource-secret-v1.jsonld",
  },
  {
    alias: "resource.sql.postgres@v1",
    path: "descriptors/contracts/resource-sql-postgres-v1.jsonld",
  },
  {
    alias: "resource.sql.sqlite-serverless@v1",
    path: "descriptors/contracts/resource-sql-sqlite-serverless-v1.jsonld",
  },
  {
    alias: "resource.vector-index@v1",
    path: "descriptors/contracts/resource-vector-index-v1.jsonld",
  },
  {
    alias: "resource.analytics-engine@v1",
    path: "descriptors/contracts/resource-analytics-engine-v1.jsonld",
  },
  {
    alias: "resource.workflow@v1",
    path: "descriptors/contracts/resource-workflow-v1.jsonld",
  },
  {
    alias: "resource.durable-object@v1",
    path: "descriptors/contracts/resource-durable-object-v1.jsonld",
  },
  {
    alias: "runtime.js-worker@v1",
    path: "descriptors/contracts/runtime-js-worker-v1.jsonld",
  },
  {
    alias: "runtime.oci-container@v1",
    path: "descriptors/contracts/runtime-oci-container-v1.jsonld",
  },
  {
    alias: "provider.aws.ecs-fargate@v1",
    path: "descriptors/providers/aws-ecs-fargate-v1.jsonld",
  },
  {
    alias: "provider.aws.s3@v1",
    path: "descriptors/providers/aws-s3-v1.jsonld",
  },
  {
    alias: "provider.cloudflare.containers@v1",
    path: "descriptors/providers/cloudflare-containers-v1.jsonld",
  },
  {
    alias: "provider.cloudflare.d1@v1",
    path: "descriptors/providers/cloudflare-d1-v1.jsonld",
  },
  {
    alias: "provider.cloudflare.r2@v1",
    path: "descriptors/providers/cloudflare-r2-v1.jsonld",
  },
  {
    alias: "provider.cloudflare.workers@v1",
    path: "descriptors/providers/cloudflare-workers-v1.jsonld",
  },
  {
    alias: "provider.google.cloud-run@v1",
    path: "descriptors/providers/google-cloud-run-v1.jsonld",
  },
  {
    alias: "provider.kubernetes.generic@v1",
    path: "descriptors/providers/kubernetes-generic-v1.jsonld",
  },
  {
    alias: "provider.neon.postgres@v1",
    path: "descriptors/providers/neon-postgres-v1.jsonld",
  },
];

const FALLBACK_DESCRIPTORS: readonly OfficialDescriptor[] = [
  loadContextDescriptor(),
];

const OFFICIAL_DESCRIPTORS: readonly OfficialDescriptor[] = [
  ...loadDocDescriptors(),
  ...FALLBACK_DESCRIPTORS,
];

export const OFFICIAL_DESCRIPTOR_CONFORMANCE_RECORDS:
  readonly OfficialDescriptorConformanceRecord[] = OFFICIAL_DESCRIPTORS
    .filter((descriptor) => descriptor.documentPath)
    .map((descriptor) => ({
      id: descriptor.id,
      alias: descriptor.alias,
      documentPath: descriptor.documentPath as string,
      body: descriptor.body,
      digest: digestOf(descriptor.body),
    })).sort((left, right) => left.alias.localeCompare(right.alias));

export const OFFICIAL_DESCRIPTOR_ALIASES: readonly string[] =
  OFFICIAL_DESCRIPTOR_CONFORMANCE_RECORDS.map((descriptor) => descriptor.alias)
    .sort();

function loadContextDescriptor(): OfficialDescriptor {
  const documentPath = "descriptors/contexts/takos-deploy-context.jsonld";
  const body = readDescriptorJson(documentPath);
  return {
    id: TAKOSUMI_CONTEXT_ID,
    alias: TAKOSUMI_CONTEXT_ID,
    documentPath,
    lifecycleDomain: "shape-derivation",
    changeEffects: [{ path: "", effect: "shape-derivation" }],
    body,
  };
}

function loadDocDescriptors(): readonly OfficialDescriptor[] {
  return DOC_DESCRIPTOR_SOURCES.map(({ alias, path }) => {
    const body = readDescriptorJson(path);
    const id = stringField(body, "@id");
    const shortRef = stringField(body, "shortRef");
    if (!id) {
      throw new TypeError(`DescriptorDocsInvalid: ${path} is missing @id`);
    }
    if (shortRef !== alias) {
      throw new TypeError(
        `DescriptorDocsInvalid: ${path} shortRef ${shortRef} does not match ${alias}`,
      );
    }
    return {
      id,
      alias,
      documentPath: path,
      lifecycleDomain: stringField(body, "lifecycleDomain"),
      changeEffects: changeEffectsFor(body),
      body,
    };
  });
}

function readDescriptorJson(path: string): JsonObject {
  const urls = [
    new URL(path, DOCS_DESCRIPTOR_ROOT_URL),
    new URL(path, PACKAGED_DESCRIPTOR_ROOT_URL),
  ];
  const notFoundErrors: Error[] = [];
  for (const url of urls) {
    try {
      const parsed = JSON.parse(Deno.readTextFileSync(url));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError(`DescriptorDocsInvalid: ${path} is not an object`);
      }
      return parsed as JsonObject;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        notFoundErrors.push(error);
        continue;
      }
      if (error instanceof SyntaxError) {
        throw new TypeError(`DescriptorDocsInvalid: ${path}: ${error.message}`);
      }
      throw error;
    }
  }
  throw new TypeError(`DescriptorDocsMissing: ${path}`);
}

function stringField(body: JsonObject, field: string): string | undefined {
  const value = body[field];
  return typeof value === "string" ? value : undefined;
}

function changeEffectsFor(
  body: JsonObject,
): readonly { path: string; effect: string }[] | undefined {
  const raw = body["changeEffects"];
  if (!Array.isArray(raw)) return undefined;
  const effects: { path: string; effect: string }[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const path = typeof item.path === "string" ? item.path : "";
    const effect = typeof item.effect === "string" ? item.effect : "";
    if (!effect) continue;
    effects.push({ path, effect });
  }
  return effects.length > 0 ? effects : undefined;
}

function digestOf(value: unknown): string {
  return `sha256:${
    createHash("sha256").update(stableStringify(value)).digest("hex")
  }`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${
      Object.keys(object).sort().map((key) =>
        `${JSON.stringify(key)}:${stableStringify(object[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
