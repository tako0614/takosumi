import { describe, expect, test } from "bun:test";
import {
  buildEdgeWorkerServiceSpec,
  buildObjectBucketServiceSpec,
  draftEdgeWorkerServiceSpec,
  parseResourceServiceTokens,
  readEdgeWorkerServiceForm,
  readObjectBucketServiceForm,
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
      name: "assets",
      interfaces: ["s3_api", "signed_url"],
    });
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
  });
});
