#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const PROOF_KIND = "takosumi.resource-shape-opentofu-provider-proof@v1";
const API_VERSION = "takosumi.dev/v1alpha1";
const PROVIDER_SOURCE = "takosjp/takosumi";
const PROVIDER_VERSION = "1.0.0";
const SPACE = "proof";

const SHAPES = [
  "EdgeWorker",
  "ObjectBucket",
  "KVStore",
  "Queue",
  "SQLDatabase",
  "ContainerService",
] as const;

type ShapeKind = (typeof SHAPES)[number];

interface ProofResource {
  readonly apiVersion: typeof API_VERSION;
  readonly kind: ShapeKind;
  readonly metadata: {
    readonly name: string;
    readonly space: string;
    readonly managedBy?: string;
    readonly id?: string;
  };
  readonly spec?: Record<string, unknown>;
  readonly targetPoolName?: string;
  readonly status?: {
    readonly phase: string;
    readonly observedGeneration: number;
    readonly resolution: {
      readonly selectedImplementation: string;
      readonly target: string;
      readonly locked: boolean;
      readonly portability: string;
    };
    readonly outputs: Record<string, string>;
    readonly conditions: readonly {
      readonly type: string;
      readonly status: string;
    }[];
  };
  readonly id?: string;
}

interface ProofTargetPoolRecord {
  readonly id: string;
  readonly spaceId: string;
  readonly name: string;
  readonly spec: Record<string, unknown>;
}

export interface ResourceShapeOpenTofuProviderProof {
  readonly kind: typeof PROOF_KIND;
  readonly status: "passed";
  readonly generatedAt: string;
  readonly tofuVersion: string;
  readonly providerBinaryDigest: string;
  readonly evidence: {
    readonly plannedResourceCount: number;
    readonly stateResourceCount: number;
    readonly previewRequestCount: number;
    readonly putResourceKinds: readonly ShapeKind[];
    readonly deleteResourceKinds: readonly ShapeKind[];
    readonly targetPoolPutCount: number;
    readonly targetPoolDeleteCount: number;
    readonly outputKeys: readonly string[];
    readonly applyOutputDigest: string;
  };
}

export async function runResourceShapeOpenTofuProviderProof(
  options: {
    readonly outputPath?: string;
    readonly now?: () => string;
  } = {},
): Promise<ResourceShapeOpenTofuProviderProof> {
  const temp = await mkdtemp(join(tmpdir(), "takosumi-resource-shape-tofu-"));
  const serverState = new ResourceShapeProofServer();
  const server = Bun.serve({
    port: 0,
    fetch: serverState.fetch,
  });

  try {
    const providerDir = join(temp, "provider-dev");
    const moduleDir = join(temp, "module");
    await mkdir(providerDir, { recursive: true });
    await mkdir(moduleDir, { recursive: true });

    const providerBinary = await buildProviderBinary(providerDir);
    const providerBinaryDigest = digestBytes(await readFile(providerBinary));
    const cliConfig = join(temp, "tofurc");
    await writeFile(
      cliConfig,
      `provider_installation {
  dev_overrides {
    "registry.opentofu.org/${PROVIDER_SOURCE}" = "${escapeHclString(providerDir)}"
  }
  direct {}
}
`,
    );
    await writeFile(join(moduleDir, "main.tf"), moduleHcl());

    const env = {
      ...process.env,
      TF_CLI_CONFIG_FILE: cliConfig,
      TF_IN_AUTOMATION: "1",
      TF_VAR_endpoint: `http://127.0.0.1:${server.port}`,
      TAKOSUMI_SPACE: SPACE,
    };

    // Provider development overrides intentionally skip `tofu init`; OpenTofu
    // tries to query the public registry during init even when the local plugin
    // binary is the desired proof subject.
    await runCommand(
      ["tofu", "plan", "-input=false", "-no-color", "-out=tfplan"],
      moduleDir,
      env,
    );
    const planJson = await runCommand(
      ["tofu", "show", "-json", "tfplan"],
      moduleDir,
      env,
    );
    const plannedResourceCount = countManagedResourceChanges(planJson);
    await runCommand(
      ["tofu", "apply", "-input=false", "-no-color", "tfplan"],
      moduleDir,
      env,
    );
    const outputsJson = await runCommand(
      ["tofu", "output", "-json"],
      moduleDir,
      env,
    );
    const stateList = await runCommand(
      ["tofu", "state", "list"],
      moduleDir,
      env,
    );
    await runCommand(
      ["tofu", "destroy", "-auto-approve", "-input=false", "-no-color"],
      moduleDir,
      env,
    );

    serverState.assertComplete();
    const outputKeys = Object.keys(
      JSON.parse(outputsJson) as Record<string, unknown>,
    ).sort();
    const proof: ResourceShapeOpenTofuProviderProof = {
      kind: PROOF_KIND,
      status: "passed",
      generatedAt: options.now?.() ?? new Date().toISOString(),
      tofuVersion: (
        await runCommand(["tofu", "version", "-json"], moduleDir, env)
      ).trim(),
      providerBinaryDigest,
      evidence: {
        plannedResourceCount,
        stateResourceCount: stateList
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean).length,
        previewRequestCount: serverState.previewCount,
        putResourceKinds: serverState.putKinds(),
        deleteResourceKinds: serverState.deleteKinds(),
        targetPoolPutCount: serverState.targetPoolPutCount,
        targetPoolDeleteCount: serverState.targetPoolDeleteCount,
        outputKeys,
        applyOutputDigest: digestBytes(Buffer.from(outputsJson)),
      },
    };
    if (proof.evidence.plannedResourceCount < SHAPES.length + 1) {
      throw new Error(
        `expected at least ${SHAPES.length + 1} planned resources, got ${proof.evidence.plannedResourceCount}`,
      );
    }
    if (proof.evidence.stateResourceCount < SHAPES.length + 1) {
      throw new Error(
        `expected at least ${SHAPES.length + 1} state resources, got ${proof.evidence.stateResourceCount}`,
      );
    }
    if (options.outputPath) {
      await writeFile(
        resolve(options.outputPath),
        `${JSON.stringify(proof, null, 2)}\n`,
      );
    }
    return proof;
  } finally {
    server.stop(true);
    await rm(temp, { recursive: true, force: true });
  }
}

class ResourceShapeProofServer {
  readonly resources = new Map<string, ProofResource>();
  readonly appliedResources: ProofResource[] = [];
  readonly deletedResources: ProofResource[] = [];
  readonly targetPools = new Map<string, ProofTargetPoolRecord>();
  previewCount = 0;
  targetPoolPutCount = 0;
  targetPoolDeleteCount = 0;

  readonly fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/.well-known/takosumi") {
      return json({
        api_versions: [API_VERSION],
        features: {
          resource_shapes: true,
          oidc: true,
        },
        endpoints: {},
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/capabilities") {
      return json({
        apiVersion: API_VERSION,
        resources: Object.fromEntries(SHAPES.map((kind) => [kind, true])),
        adapters: { opentofu: true },
        compat: {},
        identity: { oidc_issuer: true },
        commercial: { billing: false },
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/resources/preview") {
      this.previewCount++;
      const body = await request.json();
      return json({
        resource: this.readyResource(body as Partial<ProofResource>),
        selectedImplementation: "proof_preview",
        selectedTarget: "proof-target",
        portability: "portable",
        nativeResourcePlan: [],
        riskNotes: [],
        summary: "local Resource Shape provider proof preview",
      });
    }

    const resourceMatch = url.pathname.match(
      /^\/v1\/resources\/([^/]+)\/([^/]+)$/,
    );
    if (resourceMatch) {
      const kind = decodeURIComponent(resourceMatch[1]!) as ShapeKind;
      const name = decodeURIComponent(resourceMatch[2]!);
      if (!SHAPES.includes(kind)) return notFound(`unsupported kind ${kind}`);
      if (request.method === "PUT") {
        const body = (await request.json()) as Partial<ProofResource>;
        if (body.kind !== kind)
          return badRequest(`body kind ${body.kind} does not match ${kind}`);
        if (body.metadata?.managedBy !== "opentofu") {
          return badRequest("metadata.managedBy must be opentofu");
        }
        if (body.metadata?.space !== SPACE) {
          return badRequest(`metadata.space must be ${SPACE}`);
        }
        if (body.spec?.name !== name) {
          return badRequest(`spec.name must be ${name}`);
        }
        const record = this.readyResource(body);
        this.appliedResources.push(record);
        this.resources.set(
          resourceKey(kind, name, record.metadata.space),
          record,
        );
        return json(record);
      }
      if (request.method === "GET") {
        const space = url.searchParams.get("space") || SPACE;
        const record = this.resources.get(resourceKey(kind, name, space));
        return record ? json(record) : notFound(`${kind}/${name} not found`);
      }
      if (request.method === "DELETE") {
        const space = url.searchParams.get("space") || SPACE;
        const key = resourceKey(kind, name, space);
        const record = this.resources.get(key);
        if (record) this.deletedResources.push(record);
        this.resources.delete(key);
        return new Response(null, { status: 204 });
      }
    }

    const targetPoolMatch = url.pathname.match(/^\/v1\/target-pools\/([^/]+)$/);
    if (targetPoolMatch) {
      const name = decodeURIComponent(targetPoolMatch[1]!);
      if (request.method === "PUT") {
        this.targetPoolPutCount++;
        const body = (await request.json()) as {
          readonly space?: string;
          readonly spec?: Record<string, unknown>;
        };
        if (body.space !== SPACE)
          return badRequest(`target pool space must be ${SPACE}`);
        const record: ProofTargetPoolRecord = {
          id: `tkrn:${SPACE}:TargetPool:${name}`,
          spaceId: SPACE,
          name,
          spec: body.spec ?? {},
        };
        this.targetPools.set(`${SPACE}/${name}`, record);
        return json(record);
      }
      if (request.method === "GET") {
        const space = url.searchParams.get("space") || SPACE;
        const record = this.targetPools.get(`${space}/${name}`);
        return record ? json(record) : notFound(`TargetPool/${name} not found`);
      }
      if (request.method === "DELETE") {
        this.targetPoolDeleteCount++;
        const space = url.searchParams.get("space") || SPACE;
        this.targetPools.delete(`${space}/${name}`);
        return new Response(null, { status: 204 });
      }
    }

    return notFound(`${request.method} ${url.pathname}`);
  };

  readyResource(body: Partial<ProofResource>): ProofResource {
    const kind = body.kind as ShapeKind;
    const name = String(body.metadata?.name ?? body.spec?.name ?? "unnamed");
    const space = body.metadata?.space || SPACE;
    const id = `tkrn:${space}:${kind}:${name}`;
    return {
      apiVersion: API_VERSION,
      kind,
      id,
      metadata: {
        name,
        space,
        managedBy: body.metadata?.managedBy,
        id,
      },
      spec: body.spec ?? { name },
      ...(body.targetPoolName ? { targetPoolName: body.targetPoolName } : {}),
      status: {
        phase: "Ready",
        observedGeneration: 1,
        resolution: {
          selectedImplementation: `proof_${snakeCase(kind)}`,
          target: "proof-target",
          locked: true,
          portability: "portable",
        },
        outputs: {
          name,
          url: `proof://${snakeCase(kind)}/${name}`,
          resource_id: id,
        },
        conditions: [{ type: "Ready", status: "True" }],
      },
    };
  }

  putKinds(): readonly ShapeKind[] {
    return [
      ...new Set(this.appliedResources.map((record) => record.kind)),
    ].sort();
  }

  deleteKinds(): readonly ShapeKind[] {
    return [
      ...new Set(this.deletedResources.map((record) => record.kind)),
    ].sort();
  }

  assertComplete(): void {
    const putKinds = this.putKinds();
    const deleteKinds = this.deleteKinds();
    for (const kind of SHAPES) {
      if (!putKinds.includes(kind))
        throw new Error(`Resource API did not receive PUT for ${kind}`);
      if (!deleteKinds.includes(kind)) {
        throw new Error(`Resource API did not receive DELETE for ${kind}`);
      }
    }
    if (this.targetPoolPutCount < 1)
      throw new Error("TargetPool was not applied");
    if (this.targetPoolDeleteCount < 1)
      throw new Error("TargetPool was not deleted");
  }
}

async function buildProviderBinary(providerDir: string): Promise<string> {
  const binaryPath = join(providerDir, "terraform-provider-takosumi");
  await runCommand(
    ["go", "build", "-trimpath", "-o", binaryPath, "."],
    resolve("provider"),
    { ...process.env, CGO_ENABLED: process.env.CGO_ENABLED ?? "0" },
  );
  await copyFile(
    binaryPath,
    join(providerDir, `${basename(binaryPath)}_v${PROVIDER_VERSION}`),
  );
  return binaryPath;
}

function moduleHcl(): string {
  return `terraform {
  required_providers {
    takosumi = {
      source  = "${PROVIDER_SOURCE}"
      version = "${PROVIDER_VERSION}"
    }
  }
}

variable "endpoint" {
  type = string
}

provider "takosumi" {
  endpoint = var.endpoint
  space    = "${SPACE}"
}

resource "takosumi_target_pool" "default" {
  name = "default"

  target = [{
    name     = "proof-target"
    type     = "takosumi_native"
    ref      = "local-proof"
    priority = 100

    implementation = [
      {
        shape                = "EdgeWorker"
        implementation       = "proof_edge_worker"
        native_resource_type = "proof.edge_worker"
        interfaces = {
          worker_fetch     = "native"
          workers_bindings = "native"
        }
      },
      {
        shape                = "ObjectBucket"
        implementation       = "proof_object_bucket"
        native_resource_type = "proof.object_bucket"
        interfaces = {
          s3_api     = "native"
          signed_url = "native"
        }
      },
      {
        shape                = "KVStore"
        implementation       = "proof_kv_store"
        native_resource_type = "proof.kv_store"
        interfaces = {
          kv_api = "native"
        }
      },
      {
        shape                = "Queue"
        implementation       = "proof_queue"
        native_resource_type = "proof.queue"
        interfaces = {
          publish = "native"
          consume = "native"
        }
      },
      {
        shape                = "SQLDatabase"
        implementation       = "proof_sql_database"
        native_resource_type = "proof.sql_database"
        interfaces = {
          sqlite = "native"
        }
      },
      {
        shape                = "ContainerService"
        implementation       = "proof_container_service"
        native_resource_type = "proof.container_service"
        interfaces = {
          oci_container = "native"
          public_http   = "shim"
        }
      }
    ]
  }]
}

resource "takosumi_edge_worker" "api" {
  name               = "api"
  artifact_path      = "/work/dist/worker.js"
  compatibility_date = "2026-06-29"
  profiles           = ["workers_bindings"]
  target_pool        = takosumi_target_pool.default.name
}

resource "takosumi_object_bucket" "assets" {
  name        = "assets"
  interfaces  = ["s3_api", "signed_url"]
  target_pool = takosumi_target_pool.default.name
}

resource "takosumi_kv_store" "cache" {
  name        = "cache"
  consistency = "eventual"
  target_pool = takosumi_target_pool.default.name
}

resource "takosumi_queue" "delivery" {
  name           = "delivery"
  max_retries    = 5
  max_batch_size = 25
  target_pool    = takosumi_target_pool.default.name
}

resource "takosumi_sql_database" "main" {
  name            = "main"
  engine          = "sqlite"
  migrations_path = "migrations"
  target_pool     = takosumi_target_pool.default.name
}

resource "takosumi_container_service" "agent" {
  name        = "agent"
  image       = "ghcr.io/example/agent:1.0.0"
  ports       = [8080]
  public_http = true
  target_pool = takosumi_target_pool.default.name

  environment = {
    NODE_ENV = "production"
  }
}

output "shape_ids" {
  value = {
    edge_worker       = takosumi_edge_worker.api.id
    object_bucket     = takosumi_object_bucket.assets.id
    kv_store          = takosumi_kv_store.cache.id
    queue             = takosumi_queue.delivery.id
    sql_database      = takosumi_sql_database.main.id
    container_service = takosumi_container_service.agent.id
    target_pool       = takosumi_target_pool.default.id
  }
}

output "shape_urls" {
  value = {
    edge_worker       = takosumi_edge_worker.api.outputs["url"]
    object_bucket     = takosumi_object_bucket.assets.outputs["url"]
    kv_store          = takosumi_kv_store.cache.outputs["url"]
    queue             = takosumi_queue.delivery.outputs["url"]
    sql_database      = takosumi_sql_database.main.outputs["url"]
    container_service = takosumi_container_service.agent.outputs["url"]
  }
}
`;
}

async function runCommand(
  command: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const proc = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const [out, err, exitCode] = await Promise.all([stdout, stderr, proc.exited]);
  if (exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed with ${exitCode}\n${err}\n${out}`,
    );
  }
  return out;
}

function countManagedResourceChanges(planJson: string): number {
  const parsed = JSON.parse(planJson) as {
    readonly resource_changes?: readonly {
      readonly mode?: string;
      readonly change?: { readonly actions?: readonly string[] };
    }[];
  };
  return (parsed.resource_changes ?? []).filter((entry) => {
    const actions = entry.change?.actions ?? [];
    return (
      entry.mode === "managed" && actions.some((action) => action !== "no-op")
    );
  }).length;
}

function resourceKey(kind: ShapeKind, name: string, space: string): string {
  return `${space}/${kind}/${name}`;
}

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function notFound(message: string): Response {
  return json(
    { error: { code: "not_found", message, requestId: "proof" } },
    {
      status: 404,
    },
  );
}

function badRequest(message: string): Response {
  return json(
    { error: { code: "bad_request", message, requestId: "proof" } },
    {
      status: 400,
    },
  );
}

function snakeCase(value: string): string {
  return value.replace(
    /[A-Z]/g,
    (part, index) => `${index === 0 ? "" : "_"}${part.toLowerCase()}`,
  );
}

function escapeHclString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

if (import.meta.main) {
  const outputIndex = process.argv.indexOf("--output");
  const outputPath =
    outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  const proof = await runResourceShapeOpenTofuProviderProof({
    ...(outputPath ? { outputPath } : {}),
  });
  console.log(JSON.stringify(proof, null, 2));
}
