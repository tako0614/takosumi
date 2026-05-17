// core_plan — descriptor-conformance metadata only.
//
// Canonical resolution / planning / apply work lives in
// `deployment_service.ts`. This module exposes the official
// descriptor-conformance dataset consumed by docs-validation scripts and
// `core_conformance_test.ts`.

import { createHash } from "node:crypto";
import type { JsonObject } from "takosumi-contract";
import { currentRuntime } from "../../shared/runtime/index.ts";

const TAKOSUMI_CONTEXT_ID = "https://takosumi.com/contexts/deploy.jsonld";
const PUBLIC_MANIFEST_EXPANSION_DESCRIPTOR =
  "authoring.public-manifest-expansion@v1";

interface OfficialDescriptor {
  readonly id: string;
  readonly alias: string;
  readonly documentPath?: string;
  readonly lifecycleDomain?: string;
  readonly changeEffects?: readonly { path: string; effect: string }[];
  readonly body: JsonObject;
  readonly digest?: string;
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
    alias: "artifact.js-bundle@v1",
    path: "descriptors/contracts/artifact-js-bundle-v1.jsonld",
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
    alias: "artifact.js-bundle@v1",
    path: "descriptors/contracts/artifact-js-bundle-v1.jsonld",
    id: "https://takosumi.com/contracts/artifact/js-bundle/v1",
    digest:
      "sha256:8b889bb13895343b24442af2592c7a235a1b4adebf65a983da47bb5ca13a6b20",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "artifact.oci-image@v1",
    path: "descriptors/contracts/artifact-oci-image-v1.jsonld",
    id: "https://takosumi.com/contracts/artifact/oci-image/v1",
    digest:
      "sha256:07da35e19e3bc939a995f580f5b3b6dcf0d255d661629b28c69db009044b23da",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "authoring.composite-expansion@v1",
    path: "descriptors/authoring/composite-expansion-v1.jsonld",
    id: "https://takosumi.com/descriptors/authoring/composite-expansion/v1",
    digest:
      "sha256:dacae6fccc6ba7f7c4324f21e0bd11c18b019582f7199a05b8e32f4bf0721c55",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: PUBLIC_MANIFEST_EXPANSION_DESCRIPTOR,
    path: "descriptors/authoring/public-manifest-expansion-v1.jsonld",
    id:
      "https://takosumi.com/descriptors/authoring/public-manifest-expansion/v1",
    digest:
      "sha256:20fac22daf113f6f9e55dfc3c5a63b7cd6fadd5322871c1e9b7b91657e59412c",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "composite.serverless-with-postgres@v1",
    path: "descriptors/composites/composite-serverless-with-postgres-v1.jsonld",
    id: "https://takosumi.com/contracts/composite/serverless-with-postgres/v1",
    digest:
      "sha256:3966208c5bfd2c38709206ebcd71976faaddf410ead68efd603783de4ed9a362",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "composite.web-app-with-cdn@v1",
    path: "descriptors/composites/composite-web-app-with-cdn-v1.jsonld",
    id: "https://takosumi.com/contracts/composite/web-app-with-cdn/v1",
    digest:
      "sha256:023d1ccd8ec658f55de8a963b0c23ebf6932f9de335652990876af3d2729674d",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: TAKOSUMI_CONTEXT_ID,
    path: "descriptors/contexts/takos-deploy-context.jsonld",
    id: TAKOSUMI_CONTEXT_ID,
    digest:
      "sha256:1a246e542e9282327ead7d1cddef45de6020a4c0cd98c5c5f62a2c76bc52af04",
    context: {
      takos: "https://takosumi.com/vocab/deploy#",
      id: "@id",
      type: "@type",
      shortRef: "takos:shortRef",
      domain: "takos:domain",
      lifecycleDomain: "takos:lifecycleDomain",
      changeEffect: "takos:changeEffect",
      configSchema: "takos:configSchema",
      contracts: "takos:contracts",
      materializationProfiles: "takos:materializationProfiles",
      resourceAccessPaths: "takos:resourceAccessPaths",
      limitations: "takos:limitations",
      providerNativeSchemas: "takos:providerNativeSchemas",
      supports: "takos:supports",
      requires: "takos:requires",
      runtime: "takos:runtime",
      artifact: "takos:artifact",
      interfaces: "takos:interfaces",
      resources: "takos:resources",
      accessModes: "takos:accessModes",
      injectionModes: "takos:injectionModes",
      pathStages: "takos:pathStages",
      enforcement: "takos:enforcement",
    },
  },
  {
    alias: "interface.http@v1",
    path: "descriptors/contracts/interface-http-v1.jsonld",
    id: "https://takosumi.com/contracts/interface/http/v1",
    digest:
      "sha256:9d062004ddb47cfcf1bd3523d1e77fe132d3cdba690fa4b7af968d447ff8a149",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "interface.queue@v1",
    path: "descriptors/contracts/interface-queue-v1.jsonld",
    id: "https://takosumi.com/contracts/interface/queue/v1",
    digest:
      "sha256:f46b8f9b736f8f26264fb358f751a2e9d0543d5cb161952714243cca550a375e",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "interface.tcp@v1",
    path: "descriptors/contracts/interface-tcp-v1.jsonld",
    id: "https://takosumi.com/contracts/interface/tcp/v1",
    digest:
      "sha256:f33906d9668ff96e528c8c6faf142d9491204bacfbf5bcc752ec66171bd7d6bf",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "interface.udp@v1",
    path: "descriptors/contracts/interface-udp-v1.jsonld",
    id: "https://takosumi.com/contracts/interface/udp/v1",
    digest:
      "sha256:bb551434f7c86d44da06858a45cee9bacf5e505d93755e185e1efbe4411ca3d1",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "output.http-endpoint@v1",
    path: "descriptors/contracts/output-http-endpoint-v1.jsonld",
    id: "https://takosumi.com/contracts/output/http-endpoint/v1",
    digest:
      "sha256:e47afb0a17533b05cb2b5753d50228e918fed7fa7adee254eb88c8d5392762cb",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "output.mcp-server@v1",
    path: "descriptors/contracts/output-mcp-server-v1.jsonld",
    id: "https://takosumi.com/contracts/output/mcp-server/v1",
    digest:
      "sha256:3f4e8a1608e6b2f9afccca29b4ae33876d94861475654c01a891d48892d2dbd2",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "output.topic@v1",
    path: "descriptors/contracts/output-topic-v1.jsonld",
    id: "https://takosumi.com/contracts/output/topic/v1",
    digest:
      "sha256:886cc6de5084a148871c16b5af9392db5f290b2dbe90df31bac6472f85ab4223",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.aws.ecs-fargate@v1",
    path: "descriptors/providers/aws-ecs-fargate-v1.jsonld",
    id: "https://takosumi.com/providers/aws/ecs-fargate/v1",
    digest:
      "sha256:3d7f519370124b386da48ebf2c0a8afd9266906fa47075283975b8f307e21435",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.aws.s3@v1",
    path: "descriptors/providers/aws-s3-v1.jsonld",
    id: "https://takosumi.com/providers/aws/s3/v1",
    digest:
      "sha256:5038212675f2d796b71fcc7c5810d72a367c6eed4c319027b9cca4bca9afe149",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.cloudflare.containers@v1",
    path: "descriptors/providers/cloudflare-containers-v1.jsonld",
    id: "https://takosumi.com/providers/cloudflare/containers/v1",
    digest:
      "sha256:ace839787a1ab4bec1f37adff8a5b616ef4eae0247e9a7eacd72eb31fbe28728",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.cloudflare.d1@v1",
    path: "descriptors/providers/cloudflare-d1-v1.jsonld",
    id: "https://takosumi.com/providers/cloudflare/d1/v1",
    digest:
      "sha256:355ee20276988a5e3e2ee0eccaa06b6a8b4683c3f926fbf9d727a05fdfd0555a",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.cloudflare.r2@v1",
    path: "descriptors/providers/cloudflare-r2-v1.jsonld",
    id: "https://takosumi.com/providers/cloudflare/r2/v1",
    digest:
      "sha256:cad6a6627ba0664538974d56feac0436bf691a3629a17b8cb8b7750f57e7a24a",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.cloudflare.workers@v1",
    path: "descriptors/providers/cloudflare-workers-v1.jsonld",
    id: "https://takosumi.com/providers/cloudflare/workers/v1",
    digest:
      "sha256:b8cc4b6f80b3f8cb9b41f26176f84db208198b69f12adec85549ff13274f3737",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.google.cloud-run@v1",
    path: "descriptors/providers/google-cloud-run-v1.jsonld",
    id: "https://takosumi.com/providers/google/cloud-run/v1",
    digest:
      "sha256:9a4ba765efa974ff58cadd6af810e25bb24eaba700557cc4289dc595e04596cf",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.kubernetes.generic@v1",
    path: "descriptors/providers/kubernetes-generic-v1.jsonld",
    id: "https://takosumi.com/providers/kubernetes/generic/v1",
    digest:
      "sha256:71c44d01515931eb99647862923b87d74e0e76ac97a986a986cbc4c1aee5ad5d",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "provider.neon.postgres@v1",
    path: "descriptors/providers/neon-postgres-v1.jsonld",
    id: "https://takosumi.com/providers/neon/postgres/v1",
    digest:
      "sha256:f67b56d72786f3cba4480b6d5e60b774014a181009bc075c391b96a202a70dd0",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.analytics-engine@v1",
    path: "descriptors/contracts/resource-analytics-engine-v1.jsonld",
    id: "https://takosumi.com/contracts/resource/analytics-engine/v1",
    digest:
      "sha256:a3bf05789b4ec8fa575fee9e7bcb4f67c081bd6ffe066befb074fd5841c8e584",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.durable-object@v1",
    path: "descriptors/contracts/resource-durable-object-v1.jsonld",
    id: "https://takosumi.com/contracts/resource/durable-object/v1",
    digest:
      "sha256:058fdbd7076b6f62f24f49f53be7b9dfd945bf504685611fef5ef38b989dfb24",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.key-value@v1",
    path: "descriptors/contracts/resource-key-value-v1.jsonld",
    id: "https://takosumi.com/contracts/resource/key-value/v1",
    digest:
      "sha256:bb0143fae9d1ed869d4c48a47337a0cdc6519b7bc5c36f23729ff9deec83970f",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.object-store.s3@v1",
    path: "descriptors/contracts/resource-object-store-s3-v1.jsonld",
    id: "https://takosumi.com/contracts/resource/object-store/s3/v1",
    digest:
      "sha256:06425579fb767d0673887fe422ca6771d42a68c1f4f536fd8c938182d6ecd6c2",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.queue.at-least-once@v1",
    path: "descriptors/contracts/resource-queue-at-least-once-v1.jsonld",
    id: "https://takosumi.com/contracts/resource/queue/at-least-once/v1",
    digest:
      "sha256:0b142163d7bcf56929d0734b13f5076b6843afdb2c840a71b8774716ca9b902e",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.secret@v1",
    path: "descriptors/contracts/resource-secret-v1.jsonld",
    id: "https://takosumi.com/contracts/resource/secret/v1",
    digest:
      "sha256:8ee6d545068484ef7fa8ba63ce86fcb014b5639874c8f6e2ca461618dc3869c5",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.sql.postgres@v1",
    path: "descriptors/contracts/resource-sql-postgres-v1.jsonld",
    id: "https://takosumi.com/contracts/resource/sql/postgres/v1",
    digest:
      "sha256:86c1b09c772ae24a762816ba9d8a4635ace93bcc9ae0286f4c0b776c154ea717",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.sql.sqlite-serverless@v1",
    path: "descriptors/contracts/resource-sql-sqlite-serverless-v1.jsonld",
    id: "https://takosumi.com/contracts/resource/sql/sqlite-serverless/v1",
    digest:
      "sha256:6ad956c3c3b0bb8ecf5f723ef3fb94278916d8578d9e207d01fc3db8c37997ed",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "resource.vector-index@v1",
    path: "descriptors/contracts/resource-vector-index-v1.jsonld",
    id: "https://takosumi.com/contracts/resource/vector-index/v1",
    digest:
      "sha256:a9fb46e2429d19ea79f681977b6b98796d805d55a90672dde54318b2351003bb",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "runtime.js-worker@v1",
    path: "descriptors/contracts/runtime-js-worker-v1.jsonld",
    id: "https://takosumi.com/contracts/runtime/js-worker/v1",
    digest:
      "sha256:03b2586596b9bb7b2715213b87d9ca0329ac98d82d141ac4ff94d72a149f71b2",
    context: TAKOSUMI_CONTEXT_ID,
  },
  {
    alias: "runtime.oci-container@v1",
    path: "descriptors/contracts/runtime-oci-container-v1.jsonld",
    id: "https://takosumi.com/contracts/runtime/oci-container/v1",
    digest:
      "sha256:e1d00b76e163aa6fc77bbe0b597f7400257b321d7606edbb558ad136718a4c1b",
    context: TAKOSUMI_CONTEXT_ID,
  },
];

const OFFICIAL_DESCRIPTORS: readonly OfficialDescriptor[] =
  loadOfficialDescriptors();

export const OFFICIAL_DESCRIPTOR_CONFORMANCE_RECORDS:
  readonly OfficialDescriptorConformanceRecord[] = OFFICIAL_DESCRIPTORS
    .filter((descriptor) => descriptor.documentPath)
    .map((descriptor) => ({
      id: descriptor.id,
      alias: descriptor.alias,
      documentPath: descriptor.documentPath as string,
      body: descriptor.body,
      digest: descriptor.digest ?? digestOf(descriptor.body),
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

function loadOfficialDescriptors(): readonly OfficialDescriptor[] {
  if (!currentRuntime().fs.available) {
    return loadCompactDescriptors();
  }
  return [
    ...loadDocDescriptors(),
    loadContextDescriptor(),
  ];
}

function loadCompactDescriptors(): readonly OfficialDescriptor[] {
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
