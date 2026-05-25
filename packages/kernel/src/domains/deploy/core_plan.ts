// core_plan — descriptor-conformance metadata only.
//
// Canonical resolution / planning / apply work lives in
// `deployment_service.ts`. This module exposes the reference in-tree
// descriptor-conformance dataset consumed by docs-validation scripts and
// `core_conformance_test.ts`.

import { createHash } from "node:crypto";
import type { JsonObject } from "takosumi-contract/reference/compat";
import { currentRuntime } from "../../shared/runtime/index.ts";

const TAKOSUMI_CONTEXT_ID =
  "https://takosumi.com/reference/kernel/contexts/deploy.jsonld";
const PUBLIC_MANIFEST_EXPANSION_DESCRIPTOR =
  "authoring.public-manifest-expansion@v1";

interface ReferenceDescriptor {
  readonly id: string;
  readonly alias: string;
  readonly documentPath?: string;
  readonly lifecycleDomain?: string;
  readonly changeEffects?: readonly { path: string; effect: string }[];
  readonly body: JsonObject;
  readonly digest?: string;
}

export interface ReferenceDescriptorConformanceRecord {
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
    alias: "source.js-module@v1",
    path: "descriptors/contracts/source-js-module-v1.jsonld",
  },
  {
    alias: "runtime-input.oci-image@v1",
    path: "descriptors/contracts/runtime-input-oci-image-v1.jsonld",
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

const COMPACT_DESCRIPTOR_RECORDS: readonly {
  readonly alias: string;
  readonly path: string;
  readonly id: string;
  readonly digest: string;
  readonly context?: string | JsonObject;
}[] = [
  {
    alias: "source.js-module@v1",
    path: "descriptors/contracts/source-js-module-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/contracts/source/js-module/v1",
    digest:
      "sha256:13516f010ab7242a42cb88776a66289be868c5b8dd0ec4cf983a16241077916e",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "runtime-input.oci-image@v1",
    path: "descriptors/contracts/runtime-input-oci-image-v1.jsonld",
    id:
      "https://takosumi.com/reference/kernel/contracts/runtime-input/oci-image/v1",
    digest:
      "sha256:f21e62992ae3d8657fa43ffd22155d6be4edabb700325d087ad638fa056c5502",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "authoring.composite-expansion@v1",
    path: "descriptors/authoring/composite-expansion-v1.jsonld",
    id:
      "https://takosumi.com/reference/kernel/descriptors/authoring/composite-expansion/v1",
    digest:
      "sha256:27a444cc80f3c178acf5e71ae9f88d16a05212c2a1c9f8084bfaa1aad3a34f83",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: PUBLIC_MANIFEST_EXPANSION_DESCRIPTOR,
    path: "descriptors/authoring/public-manifest-expansion-v1.jsonld",
    id:
      "https://takosumi.com/reference/kernel/descriptors/authoring/public-manifest-expansion/v1",
    digest:
      "sha256:f32306654c8814e6a1bc7883ebe584ffb6140bbafbfdca57fc1d995e273cbc42",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "composite.serverless-with-postgres@v1",
    path: "descriptors/composites/composite-serverless-with-postgres-v1.jsonld",
    id:
      "https://takosumi.com/reference/kernel/contracts/composite/serverless-with-postgres/v1",
    digest:
      "sha256:f9afdb9125582ed762536ebfe4acfee8fe4ba170fdc4ad75e9ab206e2483246a",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "composite.web-app-with-cdn@v1",
    path: "descriptors/composites/composite-web-app-with-cdn-v1.jsonld",
    id:
      "https://takosumi.com/reference/kernel/contracts/composite/web-app-with-cdn/v1",
    digest:
      "sha256:513ff1a266e4b19f2685166d04d674480238e09b446a9fa3327c50b5ef8ea73e",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: TAKOSUMI_CONTEXT_ID,
    path: "descriptors/contexts/takosumi-deploy-context.jsonld",
    id: TAKOSUMI_CONTEXT_ID,
    digest:
      "sha256:1b956f4a1a82c4b965c534a0be04125e00bf4cbffc83317568c629d0ff53050f",
    context: {
      takosumi: "https://takosumi.com/reference/kernel/vocab/deploy#",
      id: "@id",
      type: "@type",
      shortRef: "takosumi:shortRef",
      domain: "takosumi:domain",
      lifecycleDomain: "takosumi:lifecycleDomain",
      changeEffect: "takosumi:changeEffect",
      configSchema: "takosumi:configSchema",
      contracts: "takosumi:contracts",
      materializationProfiles: "takosumi:materializationProfiles",
      resourceAccessPaths: "takosumi:resourceAccessPaths",
      limitations: "takosumi:limitations",
      providerNativeSchemas: "takosumi:providerNativeSchemas",
      supports: "takosumi:supports",
      requires: "takosumi:requires",
      runtime: "takosumi:runtime",
      source: "takosumi:source",
      runtimeInput: "takosumi:runtimeInput",
      interfaces: "takosumi:interfaces",
      resources: "takosumi:resources",
      accessModes: "takosumi:accessModes",
      injectionModes: "takosumi:injectionModes",
      pathStages: "takosumi:pathStages",
      enforcement: "takosumi:enforcement",
    },
  },
  {
    alias: "interface.http@v1",
    path: "descriptors/contracts/interface-http-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/contracts/interface/http/v1",
    digest:
      "sha256:5d1132ec6d94f3a08bfbeeff9e76deb9a5c843f8e2317aaabd1353f2ae1af8e0",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "interface.queue@v1",
    path: "descriptors/contracts/interface-queue-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/contracts/interface/queue/v1",
    digest:
      "sha256:217a4683ec57fee64dbb86f1e7cfcf20ac83753ef2d55a3b7422edb100643678",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "interface.tcp@v1",
    path: "descriptors/contracts/interface-tcp-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/contracts/interface/tcp/v1",
    digest:
      "sha256:a414a1f7779b0024de5c68ec3d40f3a6f8e196bd88045d07fa7f45a2d816225a",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "interface.udp@v1",
    path: "descriptors/contracts/interface-udp-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/contracts/interface/udp/v1",
    digest:
      "sha256:8ccbaca8342c49549083420bae6338d92c0b1bbf64339f077183e176f45c7094",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "output.http-endpoint@v1",
    path: "descriptors/contracts/output-http-endpoint-v1.jsonld",
    id:
      "https://takosumi.com/reference/kernel/contracts/output/http-endpoint/v1",
    digest:
      "sha256:c78ab0fd470866d5a57b82d52d615630be2e58d913e6edc396e5a67f548ce76e",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "output.mcp-server@v1",
    path: "descriptors/contracts/output-mcp-server-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/contracts/output/mcp-server/v1",
    digest:
      "sha256:d67ed4305a18a35456aa6b4ebf23b548bdc3dfc32bf0cadc73adf57a9089780b",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "output.topic@v1",
    path: "descriptors/contracts/output-topic-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/contracts/output/topic/v1",
    digest:
      "sha256:f46912b5adba741de3b7a54e47a058241fe237073d376e135df1e5e1b8ed059d",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.aws.ecs-fargate@v1",
    path: "descriptors/providers/aws-ecs-fargate-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/providers/aws/ecs-fargate/v1",
    digest:
      "sha256:08e3ce0c8d5159c7ad4277f01c1ad18e2b551f277beb55a50e2fbb7ddc34dc3a",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.aws.s3@v1",
    path: "descriptors/providers/aws-s3-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/providers/aws/s3/v1",
    digest:
      "sha256:f3d7cb8c042143ec6396ba0675af5a3228d4b70bcf049e684f0da124b07d08d3",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.cloudflare.containers@v1",
    path: "descriptors/providers/cloudflare-containers-v1.jsonld",
    id:
      "https://takosumi.com/reference/kernel/providers/cloudflare/containers/v1",
    digest:
      "sha256:a93609417d0a7c43c2f8140d4f09732442c297c3a2db792875f3712c025fe774",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.cloudflare.d1@v1",
    path: "descriptors/providers/cloudflare-d1-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/providers/cloudflare/d1/v1",
    digest:
      "sha256:e3c911dc1d8ffb6640f143f2cf02349c2bb0b566ab631fbf4faa4a69b2220778",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.cloudflare.r2@v1",
    path: "descriptors/providers/cloudflare-r2-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/providers/cloudflare/r2/v1",
    digest:
      "sha256:0958a16113f1a7eeb1c565b5723d8b0896b5932b26b17fcdb7a4b08e2bfa9ef2",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.cloudflare.workers@v1",
    path: "descriptors/providers/cloudflare-workers-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/providers/cloudflare/workers/v1",
    digest:
      "sha256:60b9d5502dc368267360c2337a56e6a81da66713f7eb1699b0d22b75dcd1cb1c",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.google.cloud-run@v1",
    path: "descriptors/providers/google-cloud-run-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/providers/google/cloud-run/v1",
    digest:
      "sha256:f902145e6eef79d9c71244fd0a73dba8638fdc51c731ca263be22d7b294df946",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.kubernetes.generic@v1",
    path: "descriptors/providers/kubernetes-generic-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/providers/kubernetes/generic/v1",
    digest:
      "sha256:020f1df5f875a0a12785f2e03d784bec9b46fbdd89d58ae1f8ef5140b0f7dace",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.neon.postgres@v1",
    path: "descriptors/providers/neon-postgres-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/providers/neon/postgres/v1",
    digest:
      "sha256:cb1bac92b4f55232d0da03d21fdfdfdf3975d29aebb35e8b467dffe7f750795a",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.analytics-engine@v1",
    path: "descriptors/contracts/resource-analytics-engine-v1.jsonld",
    id:
      "https://takosumi.com/reference/kernel/contracts/resource/analytics-engine/v1",
    digest:
      "sha256:baa7e55fcbe3c7198a9bcf927b77581cb7ef7c9d3ba3b16e6a8e88da473b722e",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.durable-object@v1",
    path: "descriptors/contracts/resource-durable-object-v1.jsonld",
    id:
      "https://takosumi.com/reference/kernel/contracts/resource/durable-object/v1",
    digest:
      "sha256:cb8e1984431236c2cc81c9883237218562951ca47c052f33e750b5fd9eb8a0f6",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.key-value@v1",
    path: "descriptors/contracts/resource-key-value-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/contracts/resource/key-value/v1",
    digest:
      "sha256:404cc7b94910c8c8616486110cc0e964753d1ccf7ba21054a8672331450ed027",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.object-store.s3@v1",
    path: "descriptors/contracts/resource-object-store-s3-v1.jsonld",
    id:
      "https://takosumi.com/reference/kernel/contracts/resource/object-store/s3/v1",
    digest:
      "sha256:d7dca9bfa45350d2168fc45a32e699ef7953037c6feab962eda744ff8329d902",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.queue.at-least-once@v1",
    path: "descriptors/contracts/resource-queue-at-least-once-v1.jsonld",
    id:
      "https://takosumi.com/reference/kernel/contracts/resource/queue/at-least-once/v1",
    digest:
      "sha256:def9b26a70b48afe43b045094b283ce16bbb485331dbdcc0ad53d8708bccc8e9",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.secret@v1",
    path: "descriptors/contracts/resource-secret-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/contracts/resource/secret/v1",
    digest:
      "sha256:cb764592bb5bf36405edb30fccb87aa47af91e89983b1e3a4d1a7d43693321f5",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.sql.postgres@v1",
    path: "descriptors/contracts/resource-sql-postgres-v1.jsonld",
    id:
      "https://takosumi.com/reference/kernel/contracts/resource/sql/postgres/v1",
    digest:
      "sha256:dac85ba58c9ad148627d5f1f106e31d5b24f74808f62eb7878d0649f2037e68f",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.sql.sqlite-serverless@v1",
    path: "descriptors/contracts/resource-sql-sqlite-serverless-v1.jsonld",
    id:
      "https://takosumi.com/reference/kernel/contracts/resource/sql/sqlite-serverless/v1",
    digest:
      "sha256:5211e966e1476d2f66ecb7c21724a8a0baf545a70d77240ed7eca2427341173e",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.vector-index@v1",
    path: "descriptors/contracts/resource-vector-index-v1.jsonld",
    id:
      "https://takosumi.com/reference/kernel/contracts/resource/vector-index/v1",
    digest:
      "sha256:5f02f4e7963245c9a6e20f895e035f320fceedd60583c9fbba281659b1883a58",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "runtime.js-worker@v1",
    path: "descriptors/contracts/runtime-js-worker-v1.jsonld",
    id: "https://takosumi.com/reference/kernel/contracts/runtime/js-worker/v1",
    digest:
      "sha256:96e36649fb62e097e129c048e8712f3b31e26c7830b5d58c74a5a2638652a145",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "runtime.oci-container@v1",
    path: "descriptors/contracts/runtime-oci-container-v1.jsonld",
    id:
      "https://takosumi.com/reference/kernel/contracts/runtime/oci-container/v1",
    digest:
      "sha256:36098e538d10690aa79754a10d2d03c320abe5410a30ddbfd4224e1e5203ed87",
    context: TAKOSUMI_CONTEXT_ID,
  },
];

const REFERENCE_DESCRIPTORS: readonly ReferenceDescriptor[] =
  loadReferenceDescriptors();

export const REFERENCE_DESCRIPTOR_CONFORMANCE_RECORDS:
  readonly ReferenceDescriptorConformanceRecord[] = REFERENCE_DESCRIPTORS
    .filter((descriptor) => descriptor.documentPath)
    .map((descriptor) => ({
      id: descriptor.id,
      alias: descriptor.alias,
      documentPath: descriptor.documentPath as string,
      body: descriptor.body,
      digest: descriptor.digest ?? digestOf(descriptor.body),
    })).sort((left, right) => left.alias.localeCompare(right.alias));

export const REFERENCE_DESCRIPTOR_ALIASES: readonly string[] =
  REFERENCE_DESCRIPTOR_CONFORMANCE_RECORDS.map((descriptor) => descriptor.alias)
    .sort();

function loadContextDescriptor(): ReferenceDescriptor {
  const documentPath = "descriptors/contexts/takosumi-deploy-context.jsonld";
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

function loadReferenceDescriptors(): readonly ReferenceDescriptor[] {
  if (!currentRuntime().fs.available) {
    return loadCompactDescriptors();
  }
  return [
    ...loadDocDescriptors(),
    loadContextDescriptor(),
  ];
}

function loadCompactDescriptors(): readonly ReferenceDescriptor[] {
  return COMPACT_DESCRIPTOR_RECORDS.map((record) => ({
    id: record.id,
    alias: record.alias,
    documentPath: record.path,
    body: compactDescriptorBody(record),
    digest: record.digest,
  }));
}

function compactDescriptorBody(
  record: (typeof COMPACT_DESCRIPTOR_RECORDS)[number],
): JsonObject {
  const body: JsonObject = {
    "@id": record.id,
    shortRef: record.alias,
  };
  if (record.context !== undefined) {
    body["@context"] = record.context;
  }
  return body;
}

function loadDocDescriptors(): readonly ReferenceDescriptor[] {
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
  const urls = descriptorRootUrls(path);
  const fs = currentRuntime().fs;
  const notFoundErrors: Error[] = [];
  for (const url of urls) {
    try {
      const parsed = JSON.parse(fs.readTextFileSync(url));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError(`DescriptorDocsInvalid: ${path} is not an object`);
      }
      return parsed as JsonObject;
    } catch (error) {
      if (fs.isNotFoundError(error)) {
        notFoundErrors.push(error as Error);
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

function descriptorRootUrls(path: string): readonly URL[] {
  const moduleUrl = moduleImportUrl();
  if (!moduleUrl) return [];
  return [
    new URL(path, new URL("../../../../../../docs/takosumi/", moduleUrl)),
    new URL(path, new URL("./", moduleUrl)),
  ];
}

function moduleImportUrl(): string | undefined {
  const value = import.meta.url;
  if (!value) return undefined;
  try {
    new URL(value);
  } catch {
    return undefined;
  }
  return value;
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
