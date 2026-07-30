import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "bun:test";

import { canonicalJson } from "../../core/adapters/takoform/canonical_json.ts";

const LIFECYCLE = [
  "create",
  "read",
  "update",
  "delete",
  "import",
  "observe",
  "refresh",
  "drift",
] as const;

const CANDIDATES = [
  ["EdgeWorker", "edge-worker"],
  ["ContainerService", "container-service"],
  ["StatefulEntity", "stateful-entity"],
  ["Schedule", "schedule"],
  ["ObjectBucket", "object-bucket"],
  ["KeyValueStore", "key-value-store"],
  ["RelationalDatabase", "relational-database"],
  ["Queue", "queue"],
  ["VectorIndex", "vector-index"],
  ["ModelEndpoint", "model-endpoint"],
] as const;

const DESIRED_BY_KIND = {
  EdgeWorker: {
    concurrency: 100,
    configuration: { LOG_LEVEL: "info" },
    connections: {
      assets: {
        permissions: ["read"],
        projection: "object.binding.v1",
        resource: "ObjectBucket/object-bucket",
      },
    },
    entrypoint: "worker.mjs",
    name: "edge-worker",
    requestTimeoutSeconds: 30,
    runtime: "javascript",
    runtimeVersion: "2026.1",
    source: {
      artifactMediaType: "application/vnd.takoform.edge-worker+tar",
      artifactSha256:
        "0f2c0c7ec3d0e2f34f1ea1f6b5f04f0b3aa03d0e6f2f2f8a7f0c5d9e4b1a8c37",
      artifactUrl:
        "https://artifacts.portable-conformance.invalid/edge-worker.tar",
    },
  },
  ContainerService: {
    configuration: { LOG_LEVEL: "info" },
    cpuMillicores: 250,
    healthCheckPath: "/healthz",
    image:
      "docker.io/library/nginx@sha256:845b5424415de5f77dd5753cbb7c1be8bd8e44cc81f20f9705783a02f8848317",
    memoryMib: 512,
    name: "container-service",
    ports: [80],
    publicHttp: true,
    replicas: 2,
  },
  StatefulEntity: {
    configuration: { LOG_LEVEL: "info" },
    entityClass: "RoomEntity",
    migrationTag: "v1",
    name: "stateful-entity",
    persistence: "transactional",
    runtime: "javascript",
    runtimeVersion: "2026.1",
    source: {
      artifactMediaType:
        "application/vnd.takoform.stateful-entity+tar",
      artifactSha256:
        "5d877f919bf8db6e6fd819e32f74dff6fc94b06f8914fa1abf5bcd2fb32ae958",
      artifactUrl:
        "https://artifacts.portable-conformance.invalid/stateful-entity.tar",
    },
  },
  Schedule: {
    connections: {
      invocation: {
        permissions: ["invoke"],
        projection: "schedule.trigger.v1",
        resource: "Workflow/workflow",
      },
    },
    cron: "0 0 * * *",
    name: "schedule",
    timezone: "UTC",
  },
  ObjectBucket: {
    accessProtocols: ["s3_api"],
    name: "object-bucket",
    storageClass: "standard",
    versioning: true,
  },
  KeyValueStore: {
    consistency: "eventual",
    defaultTtlSeconds: 3600,
    name: "key-value-store",
  },
  RelationalDatabase: {
    databaseName: "app",
    engine: "postgres",
    engineVersion: "16",
    highAvailability: false,
    name: "relational-database",
    sizeClass: "db.small",
    storageGib: 20,
  },
  Queue: {
    deliveryDelaySeconds: 0,
    maxBatchSize: 10,
    maxMessageBytes: 262144,
    maxRetries: 5,
    messageRetentionSeconds: 345600,
    name: "queue",
    ordering: "best_effort",
    visibilityTimeoutSeconds: 30,
  },
  VectorIndex: {
    dimensions: 1536,
    metric: "cosine",
    name: "vector-index",
  },
  ModelEndpoint: {
    maxConcurrency: 8,
    name: "model-endpoint",
    source: {
      artifactMediaType: "application/vnd.safetensors",
      artifactSha256:
        "fd52f6d3dfaa989615128f2049893584cc6f71a4ae5536b86681ae33ae2c072b",
      artifactUrl:
        "https://artifacts.portable-conformance.invalid/embedding-small.safetensors",
    },
    task: "embedding",
  },
} as const;

test(
  "standard Form host report build entrypoint initializes its Resource adapter",
  async () => {
    const root = await mkdtemp(
      join(tmpdir(), "takosumi-host-report-entrypoint-"),
    );
    try {
      const executionRoot = join(root, "execution");
      const takoformRoot = join(root, "takoform");
      const fakeBin = join(root, "bin");
      await mkdir(executionRoot, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(executionRoot, "README.md"),
        "isolated host-report entrypoint fixture\n",
      );
      const sourceCommit = await commitFixture(executionRoot);
      const takoformCommit = await writeTakoformFixture(takoformRoot);
      const fakeGo = join(fakeBin, "go");
      await writeFile(
        fakeGo,
        [
          "#!/bin/sh",
          "echo ENTRYPOINT_REGRESSION_REACHED_EXACT_RUNNER >&2",
          "exit 42",
          "",
        ].join("\n"),
      );
      await chmod(fakeGo, 0o755);

      const script = resolve(
        import.meta.dir,
        "../../scripts/standard-form-host-report.ts",
      );
      const child = Bun.spawn(
        [
          process.execPath,
          script,
          "build",
          "--takoform-root",
          takoformRoot,
          "--output-dir",
          join(root, "output"),
          "--request-id",
          "00000000-0000-4000-8000-000000000001",
          "--source-commit",
          sourceCommit,
          "--takoform-source-commit",
          takoformCommit,
        ],
        {
          cwd: executionRoot,
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const output = `${stdout}\n${stderr}`;

      expect(exitCode).toBe(1);
      expect(output).toContain(
        "ENTRYPOINT_REGRESSION_REACHED_EXACT_RUNNER",
      );
      expect(output).not.toContain(
        "PortableHostEvidenceResourceAdapter' before initialization",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

async function writeTakoformFixture(root: string): Promise<string> {
  const packages = [];
  let objectBucketIdentity:
    | {
        readonly formRef: {
          readonly apiVersion: string;
          readonly kind: string;
          readonly definitionVersion: string;
          readonly schemaDigest: string;
        };
        readonly packageDigest: string;
      }
    | undefined;

  for (const [kind, slug] of CANDIDATES) {
    const packageRoot = join(root, "forms", "releases", slug, "1.0.0");
    const desired = structuredClone(DESIRED_BY_KIND[kind]);
    const definition = {
      apiVersion: "forms.takoform.com/v1alpha1",
      kind,
      definitionVersion: "1.0.0",
      desiredSchema: {
        type: "object",
        additionalProperties: true,
        required: ["name"],
        properties: { name: { type: "string", minLength: 1 } },
      },
      immutableFields: [],
      lifecycleCapabilities: LIFECYCLE,
      conformanceFixtures: [
        { name: "canonical", desiredPath: "fixtures/desired.json" },
      ],
      negativeConformanceFixtures: [],
    };
    const definitionRaw = pretty(definition);
    const desiredRaw = pretty(desired);
    const formRef = {
      apiVersion: definition.apiVersion,
      kind,
      definitionVersion: definition.definitionVersion,
      schemaDigest: digest(canonicalJson(definition as never)),
    };
    const packageIndex = {
      apiVersion: "packages.forms.takoform.com/v1alpha1",
      kind: "FormPackage",
      packageVersion: "1.0.0",
      formRef,
      definitionPath: "definition.json",
      files: [
        { path: "definition.json", digest: digest(definitionRaw) },
        { path: "fixtures/desired.json", digest: digest(desiredRaw) },
      ],
    };
    const packageDigest = digest(
      canonicalJson(packageIndex as never),
    );
    await mkdir(join(packageRoot, "fixtures"), { recursive: true });
    await writeFile(join(packageRoot, "definition.json"), definitionRaw);
    await writeFile(
      join(packageRoot, "package-index.json"),
      pretty(packageIndex),
    );
    await writeFile(
      join(packageRoot, "fixtures", "desired.json"),
      desiredRaw,
    );
    packages.push({
      kind,
      slug,
      sourcePath: `forms/releases/${slug}/1.0.0`,
      formRef,
      packageDigest,
    });
    if (kind === "ObjectBucket") {
      objectBucketIdentity = { formRef, packageDigest };
    }
  }
  if (!objectBucketIdentity) {
    throw new TypeError("entrypoint fixture omitted ObjectBucket");
  }
  await mkdir(join(root, "forms"), { recursive: true });
  await writeFile(
    join(root, "forms", "admission-candidate-set.json"),
    pretty({
      format: "takoform.admission-candidate-set@v1",
      generation: "ga-core-v2",
      packages,
    }),
  );
  await mkdir(join(root, "conformance", "portable-host-v1"), {
    recursive: true,
  });
  await writeFile(
    join(root, "conformance", "portable-host-v1", "contract.json"),
    pretty({
      runnerInput: {
        connectionProbe: {
          sourceIdentity: objectBucketIdentity,
          desired: { name: "connection-target" },
        },
      },
    }),
  );
  return commitFixture(root);
}

async function commitFixture(root: string): Promise<string> {
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Takosumi Test"]);
  await git(root, ["config", "user.email", "test@takosumi.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "fixture"]);
  return git(root, ["rev-parse", "HEAD"]);
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new TypeError(
      `git ${args.join(" ")} failed: ${stderr.trim() || `exit ${exitCode}`}`,
    );
  }
  return stdout.trim();
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
