import { describe, expect, test } from "bun:test";
import { RESOURCE_SHAPE_KINDS } from "../../../../../contract/resource-shape.ts";
import {
  buildGuidedResourceServiceSpec,
  buildEdgeWorkerServiceSpec,
  buildObjectBucketServiceSpec,
  draftEdgeWorkerServiceSpec,
  GUIDED_RESOURCE_SERVICE_KINDS,
  parseResourceServiceTokens,
  readEdgeWorkerServiceForm,
  readGuidedResourceServiceForm,
  readObjectBucketServiceForm,
  type GuidedResourceServiceForm,
} from "../../../../../dashboard/src/lib/resource-service-form.ts";

describe("provider-neutral Resource service forms", () => {
  test("builds an immutable EdgeWorker URL spec without backend selection", () => {
    const result = buildEdgeWorkerServiceSpec({
      name: "api",
      artifactSource: "url",
      artifactUrl: "  https://example.test/releases/api.js  ",
      artifactRef: "ignored-ref",
      artifactSha256: `sha256:${"a".repeat(64)}`,
      compatibilityDate: "2026-07-14",
      compatibilityFlags: "nodejs_compat, nodejs_compat",
      profiles: "workers_bindings\nnode_compat",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        name: "api",
        source: {
          artifactUrl: "https://example.test/releases/api.js",
          artifactSha256: `sha256:${"a".repeat(64)}`,
        },
        compatibilityDate: "2026-07-14",
        compatibilityFlags: ["nodejs_compat"],
        profiles: ["workers_bindings", "node_compat"],
      },
    });
    if (result.ok) {
      expect(JSON.stringify(result.value)).not.toMatch(
        /provider|manager|cloudflare|targetPool/iu,
      );
    }
  });

  test("builds an opaque EdgeWorker artifact ref and requires its digest", () => {
    const artifactRef = `edge-worker-artifact:v1:${"b".repeat(64)}`;
    expect(
      buildEdgeWorkerServiceSpec({
        name: "api",
        artifactSource: "ref",
        artifactUrl: "",
        artifactRef,
        artifactSha256: `sha256:${"b".repeat(64)}`,
        compatibilityDate: "",
        compatibilityFlags: "",
        profiles: "",
      }),
    ).toEqual({
      ok: true,
      value: {
        name: "api",
        source: {
          artifactRef,
          artifactSha256: `sha256:${"b".repeat(64)}`,
        },
      },
    });

    expect(
      buildEdgeWorkerServiceSpec({
        name: "api",
        artifactSource: "ref",
        artifactUrl: "",
        artifactRef,
        artifactSha256: "",
        compatibilityDate: "",
        compatibilityFlags: "",
        profiles: "",
      }),
    ).toEqual({ ok: false, code: "artifact_sha256_required" });
  });

  test("rejects mutable/non-HTTPS URL input before preview", () => {
    const form = {
      name: "api",
      artifactSource: "url" as const,
      artifactUrl: "http://example.test/api.js",
      artifactRef: "",
      artifactSha256: "a".repeat(64),
      compatibilityDate: "",
      compatibilityFlags: "",
      profiles: "",
    };
    expect(buildEdgeWorkerServiceSpec(form)).toEqual({
      ok: false,
      code: "artifact_url_https",
    });
    expect(draftEdgeWorkerServiceSpec(form)).toEqual({
      name: "api",
      source: {
        artifactUrl: "http://example.test/api.js",
        artifactSha256: "a".repeat(64),
      },
    });
  });

  test("normalizes ObjectBucket interface requirements without owning a catalog", () => {
    expect(parseResourceServiceTokens("s3_api, signed_url\ns3_api")).toEqual([
      "s3_api",
      "signed_url",
    ]);
    expect(
      buildObjectBucketServiceSpec({
        name: "assets",
        interfaces: "s3_api, signed_url\ns3_api",
      }),
    ).toEqual({
      ok: true,
      value: {
        name: "assets",
        interfaces: ["s3_api", "signed_url"],
      },
    });
  });

  test("builds every Stable bundled Resource Shape through one guided contract", () => {
    const forms: readonly GuidedResourceServiceForm[] = [
      {
        kind: "EdgeWorker",
        form: {
          name: "edge",
          artifactSource: "ref",
          artifactUrl: "",
          artifactRef: "artifact:edge:v1",
          artifactSha256: "a".repeat(64),
          compatibilityDate: "",
          compatibilityFlags: "",
          profiles: "",
        },
      },
      {
        kind: "ObjectBucket",
        form: { name: "objects", interfaces: "s3_api" },
      },
      {
        kind: "KVStore",
        form: { name: "settings", consistency: "strong" },
      },
      {
        kind: "SQLDatabase",
        form: {
          name: "app-db",
          engine: "sqlite",
          migrationsPath: "migrations",
        },
      },
      {
        kind: "Queue",
        form: { name: "jobs", maxRetries: "3", maxBatchSize: "25" },
      },
      {
        kind: "VectorIndex",
        form: { name: "documents", dimensions: "768", metric: "cosine" },
      },
      {
        kind: "DurableWorkflow",
        form: {
          name: "pipeline",
          artifactSource: "url",
          artifactUrl: "https://example.test/pipeline.js",
          artifactRef: "",
          artifactSha256: "b".repeat(64),
          entrypoint: "run",
          maxAttempts: "5",
          initialBackoffSeconds: "10",
        },
      },
      {
        kind: "ContainerService",
        form: {
          name: "api",
          image: "registry.example.test/api@sha256:abc",
          ports: "8080, 9090",
          publicHttp: "true",
          environment: '{\n  "MODE": "production"\n}',
        },
      },
      {
        kind: "StatefulActorNamespace",
        form: {
          name: "rooms",
          className: "ChatRoom",
          storageProfile: "durable_sqlite",
          migrationTag: "v1",
        },
      },
      {
        kind: "Schedule",
        form: {
          name: "hourly",
          cron: "0 * * * *",
          timezone: "UTC",
          connectionName: "target",
          targetResource: "EdgeWorker/edge",
        },
      },
    ];

    expect(forms.map((item) => item.kind)).toEqual(
      GUIDED_RESOURCE_SERVICE_KINDS,
    );
    expect([...GUIDED_RESOURCE_SERVICE_KINDS].sort()).toEqual(
      [...RESOURCE_SHAPE_KINDS].sort(),
    );
    for (const input of forms) {
      const built = buildGuidedResourceServiceSpec(input);
      expect(built.ok).toBeTrue();
      if (!built.ok) continue;
      expect(JSON.stringify(built.value)).not.toMatch(
        /provider|manager|cloudflare|targetPool/iu,
      );
      expect(
        readGuidedResourceServiceForm(input.kind, built.value, input.form.name),
      ).toEqual(input);
    }
  });

  test("validates required and integer fields before preview", () => {
    expect(
      buildGuidedResourceServiceSpec({
        kind: "VectorIndex",
        form: { name: "vectors", dimensions: "0", metric: "" },
      }),
    ).toEqual({ ok: false, code: "vector_dimensions_invalid" });
    expect(
      buildGuidedResourceServiceSpec({
        kind: "ContainerService",
        form: {
          name: "api",
          image: "",
          ports: "",
          publicHttp: "",
          environment: "{}",
        },
      }),
    ).toEqual({ ok: false, code: "container_image_required" });
    expect(
      buildGuidedResourceServiceSpec({
        kind: "Schedule",
        form: {
          name: "hourly",
          cron: "* * *",
          timezone: "UTC",
          connectionName: "target",
          targetResource: "EdgeWorker/api",
        },
      }),
    ).toEqual({ ok: false, code: "schedule_cron_invalid" });
  });

  test("uses guided editing only when it can round-trip the complete spec", () => {
    expect(
      readEdgeWorkerServiceForm(
        {
          name: "api",
          source: {
            artifactUrl: "https://example.test/api.js",
            artifactSha256: "a".repeat(64),
          },
          profiles: ["workers_bindings"],
        },
        "api",
      ),
    ).toMatchObject({
      name: "api",
      artifactSource: "url",
      profiles: "workers_bindings",
    });
    expect(
      readEdgeWorkerServiceForm(
        {
          name: "api",
          source: { artifactPath: "/work/api.js" },
        },
        "api",
      ),
    ).toBeUndefined();
    expect(
      readEdgeWorkerServiceForm(
        {
          name: "api",
          source: {
            artifactUrl: "https://example.test/api.js",
            artifactSha256: "a".repeat(64),
          },
          lifecyclePolicy: { delete: "retain" },
        },
        "api",
      ),
    ).toBeUndefined();
    expect(
      readObjectBucketServiceForm(
        { name: "assets", interfaces: ["s3_api"] },
        "assets",
      ),
    ).toEqual({ name: "assets", interfaces: "s3_api" });
    expect(readObjectBucketServiceForm({ name: "assets" }, "assets")).toEqual({
      name: "assets",
      interfaces: "",
    });
    expect(
      readGuidedResourceServiceForm(
        "KVStore",
        {
          name: "settings",
          consistency: "strong",
          lifecyclePolicy: { delete: "retain" },
        },
        "settings",
      ),
    ).toBeUndefined();
  });
});
