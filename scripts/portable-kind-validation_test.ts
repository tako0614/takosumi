import { assertEquals } from "jsr:@std/assert@^1.0.6";
import type {
  Shape,
  ShapeValidationIssue,
} from "../packages/contract/src/shape.ts";
import { GatewayKind } from "../src/kinds/gateway/src/gateway.ts";
import { KvStoreKind } from "../src/kinds/kv-store/src/kv-store.ts";
import { MessageQueueKind } from "../src/kinds/message-queue/src/message-queue.ts";
import { ObjectStoreKind } from "../src/kinds/object-store/src/object-store.ts";
import { DatabasePostgresKind } from "../src/kinds/postgres/src/database-postgres.ts";
import { SqliteKind } from "../src/kinds/sqlite/src/sqlite.ts";
import { VectorStoreKind } from "../src/kinds/vector-store/src/vector-store.ts";
import { WebServiceKind } from "../src/kinds/web-service/src/web-service.ts";
import { WorkerKind } from "../src/kinds/worker/src/worker.ts";

type Case = {
  readonly name: string;
  readonly shape: Shape;
  readonly spec: Record<string, unknown>;
  readonly outputs: Record<string, unknown>;
};

const CASES: readonly Case[] = [
  {
    name: "worker",
    shape: WorkerKind,
    spec: {
      entrypoint: "src/main.ts",
      env: { NODE_ENV: "production" },
    },
    outputs: {
      url: "https://worker.example.test",
      id: "worker-id",
      version: "2026-05-26",
    },
  },
  {
    name: "web-service",
    shape: WebServiceKind,
    spec: {
      image: "registry.example.test/app:1",
      port: 8080,
      scale: { min: 1, max: 3 },
      env: { NODE_ENV: "production" },
      resources: { cpu: "500m", memory: "512Mi" },
    },
    outputs: {
      url: "https://app.example.test",
      internalHost: "app.internal",
      internalPort: 8080,
    },
  },
  {
    name: "postgres",
    shape: DatabasePostgresKind,
    spec: {
      version: "16",
      size: "small",
      storage: { sizeGiB: 20 },
      highAvailability: false,
    },
    outputs: {
      host: "db.internal",
      port: 5432,
      database: "app",
      username: "app",
      passwordSecretRef: "secret://postgres/password",
      connectionString: "postgres://app@db.internal:5432/app",
    },
  },
  {
    name: "object-store",
    shape: ObjectStoreKind,
    spec: {
      name: "assets",
    },
    outputs: {
      bucket: "assets",
      endpoint: "https://object-store.example.test",
      region: "local",
      accessKeyIdRef: "secret://assets/access-key-id",
      secretAccessKeyRef: "secret://assets/secret-access-key",
    },
  },
  {
    name: "kv-store",
    shape: KvStoreKind,
    spec: {
      name: "sessions",
    },
    outputs: {
      storeId: "kv-sessions",
      name: "sessions",
      url: "https://kv.example.test/sessions",
      tokenSecretRef: "secret://kv/token",
    },
  },
  {
    name: "message-queue",
    shape: MessageQueueKind,
    spec: {
      name: "jobs",
      deliveryDelay: 0,
    },
    outputs: {
      queueId: "queue-jobs",
      name: "jobs",
      url: "https://queue.example.test/jobs",
      producerTokenSecretRef: "secret://queue/producer",
      consumerTokenSecretRef: "secret://queue/consumer",
    },
  },
  {
    name: "sqlite",
    shape: SqliteKind,
    spec: {
      name: "app",
    },
    outputs: {
      databaseId: "sqlite-app",
      name: "app",
      url: "libsql://sqlite.example.test/app",
      tokenSecretRef: "secret://sqlite/token",
    },
  },
  {
    name: "vector-store",
    shape: VectorStoreKind,
    spec: {
      name: "embeddings",
      dimensions: 1536,
      metric: "cosine",
    },
    outputs: {
      indexId: "vector-embeddings",
      name: "embeddings",
      url: "https://vector.example.test/embeddings",
      tokenSecretRef: "secret://vector/token",
    },
  },
  {
    name: "gateway",
    shape: GatewayKind,
    spec: {
      listeners: {
        public: {
          protocol: "https",
          host: "app.example.test",
          tls: "auto",
        },
      },
      routes: [{ listener: "public", path: "/", to: "app" }],
    },
    outputs: {
      url: "https://app.example.test",
      host: "app.example.test",
      listener: "public",
      routes: [{ pathPrefix: "/", to: "app" }],
      scheme: "https",
    },
  },
];

Deno.test("portable kind specs reject unknown top-level fields", () => {
  for (const entry of CASES) {
    assertEquals(
      validateSpec(entry.shape, { ...entry.spec, unsupported: true }),
      [{ path: "$.unsupported", message: "unknown field" }],
      entry.name,
    );
  }
});

Deno.test("portable kind outputs reject unknown top-level fields", () => {
  for (const entry of CASES) {
    assertEquals(
      validateOutputs(entry.shape, { ...entry.outputs, unsupported: true }),
      [{ path: "$.unsupported", message: "unknown field" }],
      entry.name,
    );
  }
});

Deno.test("portable kind nested objects reject unknown fields", () => {
  assertEquals(
    validateSpec(WebServiceKind, {
      image: "registry.example.test/app:1",
      port: 8080,
      scale: { min: 1, max: 3, unsupported: true },
      resources: { cpu: "500m", memory: "512Mi", unsupported: true },
    }),
    [
      { path: "$.scale.unsupported", message: "unknown field" },
      { path: "$.resources.unsupported", message: "unknown field" },
    ],
  );

  assertEquals(
    validateSpec(DatabasePostgresKind, {
      version: "16",
      size: "small",
      storage: { sizeGiB: 20, unsupported: true },
    }),
    [{ path: "$.storage.unsupported", message: "unknown field" }],
  );

  assertEquals(
    validateSpec(GatewayKind, {
      listeners: {
        public: { protocol: "https", unsupported: true },
      },
      routes: [{
        listener: "public",
        path: "/",
        to: "app",
        unsupported: true,
      }],
    }),
    [
      { path: "$.listeners.public.unsupported", message: "unknown field" },
      { path: "$.routes[0].unsupported", message: "unknown field" },
    ],
  );

  assertEquals(
    validateOutputs(GatewayKind, {
      url: "https://app.example.test",
      host: "app.example.test",
      listener: "public",
      routes: [{ pathPrefix: "/", to: "app", unsupported: true }],
      scheme: "https",
    }),
    [{ path: "$.routes[0].unsupported", message: "unknown field" }],
  );
});

Deno.test("portable web-service scale and postgres size are optional hints", () => {
  assertEquals(
    validateSpec(WebServiceKind, {
      image: "registry.example.test/app:1",
      port: 8080,
    }),
    [],
  );
  assertEquals(
    validateSpec(DatabasePostgresKind, {
      version: "16",
    }),
    [],
  );
});

Deno.test("portable HTTP outputs require absolute http(s) URLs", () => {
  assertEquals(
    validateOutputs(WorkerKind, {
      url: "not-url",
      id: "worker-id",
    }),
    [{ path: "$.url", message: "must be an absolute http(s) URL" }],
  );
  assertEquals(
    validateOutputs(WebServiceKind, {
      url: "ftp://app.example.test",
      internalHost: "app.internal",
      internalPort: 8080,
    }),
    [{ path: "$.url", message: "must be an absolute http(s) URL" }],
  );
  assertEquals(
    validateOutputs(GatewayKind, {
      url: "app.example.test",
      host: "app.example.test",
      listener: "public",
      routes: [{ pathPrefix: "/", to: "app" }],
      scheme: "https",
    }),
    [{ path: "$.url", message: "must be an absolute http(s) URL" }],
  );
  assertEquals(
    validateOutputs(WorkerKind, {
      url: "https://user:pass@worker.example.test",
      id: "worker-id",
    }),
    [{ path: "$.url", message: "must not contain embedded credentials" }],
  );
});

Deno.test("portable worker entrypoint uses source-root-relative path grammar", () => {
  for (
    const entrypoint of [
      "/src/main.ts",
      "src//main.ts",
      "src/./main.ts",
      "src/../main.ts",
      "src/\0main.ts",
    ]
  ) {
    assertEquals(
      validateSpec(WorkerKind, { entrypoint }),
      [{
        path: "$.entrypoint",
        message:
          "must be a POSIX relative path without NUL, empty, ., or .. segments",
      }],
      entrypoint,
    );
  }
});

Deno.test("portable worker schedules are an optional cron-trigger array", () => {
  // Absent schedules stay valid (additive, optional field).
  assertEquals(
    validateSpec(WorkerKind, { entrypoint: "src/main.ts" }),
    [],
  );
  // A well-formed schedules array validates. The cron dialect is not
  // over-validated here: any non-empty string is accepted (5- or 6-field,
  // Cloudflare cron or Deno.cron), and unsupported dialects are rejected by
  // the resolving backend at apply.
  assertEquals(
    validateSpec(WorkerKind, {
      entrypoint: "src/main.ts",
      schedules: [{ cron: "*/5 * * * *" }, { cron: "0 0 1 1 *" }],
    }),
    [],
  );
});

Deno.test("portable worker schedules reject malformed entries", () => {
  assertEquals(
    validateSpec(WorkerKind, {
      entrypoint: "src/main.ts",
      schedules: "*/5 * * * *",
    }),
    [{ path: "$.schedules", message: "must be an array" }],
  );
  assertEquals(
    validateSpec(WorkerKind, {
      entrypoint: "src/main.ts",
      schedules: [{ cron: "" }, { cron: 5 }, "not-an-object"],
    }),
    [
      {
        path: "$.schedules[0].cron",
        message: "must be a non-empty cron expression",
      },
      {
        path: "$.schedules[1].cron",
        message: "must be a non-empty cron expression",
      },
      { path: "$.schedules[2]", message: "must be an object" },
    ],
  );
  assertEquals(
    validateSpec(WorkerKind, {
      entrypoint: "src/main.ts",
      schedules: [{ cron: "*/5 * * * *", timezone: "UTC" }],
    }),
    [{ path: "$.schedules[0].timezone", message: "unknown field" }],
  );
});

Deno.test("portable gateway outputs keep url, scheme, host, and listener coherent", () => {
  assertEquals(
    validateOutputs(GatewayKind, {
      url: "https://app.example.test",
      host: "other.example.test",
      listener: "public.main",
      routes: [{ pathPrefix: "/", to: "app" }],
      scheme: "http",
    }),
    [
      {
        path: "$.listener",
        message: "must match ^[a-z][a-z0-9-]{0,62}$",
      },
      { path: "$.scheme", message: "must match the scheme in url" },
      { path: "$.host", message: "must match the host in url" },
    ],
  );
});

Deno.test("portable data outputs reject invalid connection URLs", () => {
  assertEquals(
    validateOutputs(DatabasePostgresKind, {
      host: "db.internal",
      port: 5432,
      database: "app",
      username: "app",
      passwordSecretRef: "secret://postgres/password",
      connectionString: "postgres://app:secret@db.internal:5432/app",
    }),
    [{
      path: "$.connectionString",
      message: "must not contain an embedded password",
    }],
  );
  assertEquals(
    validateOutputs(ObjectStoreKind, {
      bucket: "assets",
      endpoint: "not-url",
    }),
    [{ path: "$.endpoint", message: "must be an absolute http(s) URL" }],
  );
  assertEquals(
    validateOutputs(KvStoreKind, {
      storeId: "kv-sessions",
      name: "sessions",
      url: "not-url",
    }),
    [{ path: "$.url", message: "must be an absolute URI" }],
  );
  assertEquals(
    validateOutputs(MessageQueueKind, {
      queueId: "queue-jobs",
      name: "jobs",
      url: "queue://producer:secret@example.test/jobs",
    }),
    [{ path: "$.url", message: "must not contain an embedded password" }],
  );
  assertEquals(
    validateOutputs(VectorStoreKind, {
      indexId: "vector-embeddings",
      name: "embeddings",
      url: "https://user:secret@vector.example.test/embeddings",
    }),
    [{ path: "$.url", message: "must not contain an embedded password" }],
  );
});

Deno.test("portable gateway output route summaries use route grammar", () => {
  assertEquals(
    validateOutputs(GatewayKind, {
      url: "https://app.example.test",
      host: "app.example.test",
      listener: "public",
      routes: [{ pathPrefix: "api", to: "app.one" }],
      scheme: "https",
    }),
    [
      {
        path: "$.routes[0].pathPrefix",
        message:
          'must be a path beginning with "/" and contain no ?, #, or NUL',
      },
      {
        path: "$.routes[0].to",
        message: "must match ^[a-z][a-z0-9-]{0,62}$",
      },
    ],
  );
});

Deno.test("portable port fields stay inside TCP/UDP port range", () => {
  assertEquals(
    validateSpec(WebServiceKind, {
      image: "registry.example.test/app:1",
      port: 70000,
    }),
    [{ path: "$.port", message: "must be an integer from 1 to 65535" }],
  );
  assertEquals(
    validateOutputs(WebServiceKind, {
      url: "https://app.example.test",
      internalHost: "app.internal",
      internalPort: 70000,
    }),
    [{
      path: "$.internalPort",
      message: "must be an integer from 1 to 65535",
    }],
  );
  assertEquals(
    validateOutputs(DatabasePostgresKind, {
      host: "db.internal",
      port: 70000,
      database: "app",
      username: "app",
      passwordSecretRef: "secret://postgres/password",
      connectionString: "postgres://app@db.internal:5432/app",
    }),
    [{ path: "$.port", message: "must be an integer from 1 to 65535" }],
  );
});

Deno.test("portable gateway requires at least one declared listener", () => {
  assertEquals(
    validateSpec(GatewayKind, {
      listeners: {},
      routes: [{ listener: "public", path: "/", to: "app" }],
    }),
    [
      { path: "$.listeners", message: "must declare at least one listener" },
      {
        path: "$.routes[0].listener",
        message: "must reference a listener declared in $.listeners",
      },
    ],
  );
});

Deno.test("portable object-store spec keeps backend controls in native kinds", () => {
  assertEquals(
    validateSpec(ObjectStoreKind, {
      name: "assets",
      public: false,
      versioning: true,
      region: "local",
    }),
    [
      { path: "$.public", message: "unknown field" },
      { path: "$.versioning", message: "unknown field" },
      { path: "$.region", message: "unknown field" },
    ],
  );
});

Deno.test("portable data specs keep backend-specific controls in native kinds", () => {
  assertEquals(
    validateSpec(KvStoreKind, {
      name: "sessions",
      ttl: 3600,
    }),
    [{ path: "$.ttl", message: "unknown field" }],
  );

  assertEquals(
    validateSpec(MessageQueueKind, {
      name: "jobs",
      retries: 3,
    }),
    [{ path: "$.retries", message: "unknown field" }],
  );
});

Deno.test("portable vector-store requires index shape", () => {
  assertEquals(
    validateSpec(VectorStoreKind, {
      name: "embeddings",
    }),
    [
      { path: "$.dimensions", message: "must be a positive integer" },
      {
        path: "$.metric",
        message: "must be one of: cosine, euclidean, dot-product",
      },
    ],
  );
});

function validateSpec(shape: Shape, value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  shape.validateSpec(value, issues);
  return issues;
}

function validateOutputs(shape: Shape, value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  shape.validateOutputs(value, issues);
  return issues;
}
