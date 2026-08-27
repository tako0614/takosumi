import { expect, test } from "bun:test";

import {
  assertRunnerImageOnlyConfigChange,
  createRunnerTransportTag,
  parseRemoteRunnerManifest,
} from "../../scripts/runner-image-release.ts";

const COMMIT = "a".repeat(40);
const DOCKERFILE_DIGEST = "b".repeat(64);
const PREVIOUS =
  `registry.cloudflare.com/${"c".repeat(32)}/takosumi-runner@sha256:${"d".repeat(64)}`;
const NEXT =
  `registry.cloudflare.com/${"c".repeat(32)}/takosumi-runner@sha256:${"e".repeat(64)}`;

function config(image = PREVIOUS): string {
  return [
    'name = "takosumi-staging"',
    'main = "../takosumi/deploy/platform/entry-worker.ts"',
    'compatibility_date = "2026-04-01"',
    "",
    "[[containers]]",
    'class_name = "OpenTofuRunnerObject"',
    `image = "${image}"`,
    'instance_type = "dev"',
    "max_instances = 1",
    "",
    "[[migrations]]",
    'tag = "v1"',
    'new_sqlite_classes = ["CoordinationObject", "OpenTofuRunnerObject"]',
    "",
  ].join("\n");
}

test("runner activation config is the exact image-literal-only transform", () => {
  const expected = config(NEXT);
  expect(
    assertRunnerImageOnlyConfigChange(config(), expected, PREVIOUS, NEXT),
  ).toBeString();

  for (const unrelated of [
    expected.replace('compatibility_date = "2026-04-01"', 'compatibility_date = "2026-04-02"'),
    expected.replace("max_instances = 1", "max_instances = 2"),
    expected.replace('tag = "v1"', 'tag = "v2"'),
    expected.replace("[[migrations]]", "# unrelated comment\n[[migrations]]"),
    `${expected}[[routes]]\npattern = "other.example/*"\n`,
  ]) {
    expect(() =>
      assertRunnerImageOnlyConfigChange(config(), unrelated, PREVIOUS, NEXT),
    ).toThrow("runner_image_activation_config_not_image_only");
  }
});

test("transport tags are source/content/nonce bound and never the consumer identity", () => {
  const first = createRunnerTransportTag(
    COMMIT,
    DOCKERFILE_DIGEST,
    "01".repeat(16),
  );
  const second = createRunnerTransportTag(
    COMMIT,
    DOCKERFILE_DIGEST,
    "02".repeat(16),
  );
  expect(first).not.toBe(second);
  expect(first).toContain(COMMIT.slice(0, 12));
  expect(first).toContain(DOCKERFILE_DIGEST.slice(0, 12));
  expect(first).not.toContain("1.0.0");
});

test("remote manifest readback binds the generated transport ref despite tag interleaving", () => {
  const tag = createRunnerTransportTag(
    COMMIT,
    DOCKERFILE_DIGEST,
    "01".repeat(16),
  );
  const remote = `registry.cloudflare.com/${"c".repeat(32)}/takosumi-runner:${tag}`;
  const observed = parseRemoteRunnerManifest(
    `Pushed image: ${remote}\nPushed image: registry.cloudflare.com/${"c".repeat(32)}/takosumi-runner:unrelated`,
    JSON.stringify({
      Descriptor: {
        mediaType: "application/vnd.docker.distribution.manifest.v2+json",
        digest: `sha256:${"e".repeat(64)}`,
        platform: { architecture: "amd64", os: "linux" },
      },
      SchemaV2Manifest: {
        schemaVersion: 2,
        mediaType: "application/vnd.docker.distribution.manifest.v2+json",
        config: { digest: `sha256:${"f".repeat(64)}` },
      },
    }),
    tag,
    `sha256:${"e".repeat(64)}`,
  );
  expect(observed).toEqual({
    transportRef: remote,
    immutableRef: NEXT,
    imageConfigDigest: `sha256:${"f".repeat(64)}`,
  });
});

test("remote OCI manifest binds the local Docker descriptor digest while preserving the config digest", () => {
  const tag = createRunnerTransportTag(
    COMMIT,
    DOCKERFILE_DIGEST,
    "01".repeat(16),
  );
  const remote = `registry.cloudflare.com/${"c".repeat(32)}/takosumi-runner:${tag}`;
  const manifestOutput = JSON.stringify({
    Descriptor: {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: `sha256:${"e".repeat(64)}`,
      platform: { architecture: "amd64", os: "linux" },
    },
    OCIManifest: {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest: `sha256:${"f".repeat(64)}` },
    },
  });
  const observed = parseRemoteRunnerManifest(
    `Pushed image: ${remote}`,
    manifestOutput,
    tag,
    `sha256:${"e".repeat(64)}`,
  );
  expect(observed).toEqual({
    transportRef: remote,
    immutableRef: NEXT,
    imageConfigDigest: `sha256:${"f".repeat(64)}`,
  });
  expect(() =>
    parseRemoteRunnerManifest(
      `Pushed image: ${remote}`,
      manifestOutput,
      tag,
      `sha256:${"f".repeat(64)}`,
    ),
  ).toThrow("runner_image_remote_content_mismatch");
  expect(() =>
    parseRemoteRunnerManifest(
      `Pushed image: ${remote}`,
      manifestOutput,
      tag,
      `sha256:${"0".repeat(64)}`,
    ),
  ).toThrow("runner_image_remote_content_mismatch");
});

test("remote manifest rejects ambiguous Docker and OCI payloads", () => {
  const tag = createRunnerTransportTag(
    COMMIT,
    DOCKERFILE_DIGEST,
    "01".repeat(16),
  );
  const remote = `registry.cloudflare.com/${"c".repeat(32)}/takosumi-runner:${tag}`;
  for (const ociConfigDigest of [
    `sha256:${"f".repeat(64)}`,
    `sha256:${"0".repeat(64)}`,
  ]) {
    expect(() =>
      parseRemoteRunnerManifest(
        `Pushed image: ${remote}`,
        JSON.stringify({
          Descriptor: {
            digest: `sha256:${"e".repeat(64)}`,
            platform: { architecture: "amd64", os: "linux" },
          },
          SchemaV2Manifest: {
            schemaVersion: 2,
            config: { digest: `sha256:${"f".repeat(64)}` },
          },
          OCIManifest: {
            schemaVersion: 2,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            config: { digest: ociConfigDigest },
          },
        }),
        tag,
        `sha256:${"f".repeat(64)}`,
      ),
    ).toThrow("runner_image_remote_manifest_invalid");
  }
});

test("remote OCI manifest requires the OCI image manifest media type", () => {
  const tag = createRunnerTransportTag(
    COMMIT,
    DOCKERFILE_DIGEST,
    "01".repeat(16),
  );
  const remote = `registry.cloudflare.com/${"c".repeat(32)}/takosumi-runner:${tag}`;
  const descriptor = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: `sha256:${"e".repeat(64)}`,
    platform: { architecture: "amd64", os: "linux" },
  };
  const payload = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: `sha256:${"f".repeat(64)}` },
  };

  for (const manifest of [
    {
      Descriptor: {
        digest: descriptor.digest,
        platform: descriptor.platform,
      },
      OCIManifest: payload,
    },
    {
      Descriptor: descriptor,
      OCIManifest: {
        schemaVersion: 2,
        config: payload.config,
      },
    },
    {
      Descriptor: {
        ...descriptor,
        mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      },
      OCIManifest: payload,
    },
    {
      Descriptor: descriptor,
      OCIManifest: {
        ...payload,
        mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      },
    },
  ]) {
    expect(() =>
      parseRemoteRunnerManifest(
        `Pushed image: ${remote}`,
        JSON.stringify(manifest),
        tag,
        descriptor.digest,
      ),
    ).toThrow("runner_image_remote_manifest_invalid");
  }
});

test("remote OCI manifest rejects wrong schema or platform, multiple manifests, and missing config", () => {
  const tag = createRunnerTransportTag(
    COMMIT,
    DOCKERFILE_DIGEST,
    "01".repeat(16),
  );
  const remote = `registry.cloudflare.com/${"c".repeat(32)}/takosumi-runner:${tag}`;
  const descriptor = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: `sha256:${"e".repeat(64)}`,
    platform: { architecture: "amd64", os: "linux" },
  };
  const payload = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: `sha256:${"f".repeat(64)}` },
  };
  const valid = { Descriptor: descriptor, OCIManifest: payload };

  for (const manifest of [
    [valid],
    {
      ...valid,
      Descriptor: {
        ...descriptor,
        platform: { architecture: "arm64", os: "linux" },
      },
    },
    { ...valid, OCIManifest: { ...payload, schemaVersion: 1 } },
    {
      ...valid,
      OCIManifest: {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
      },
    },
    { ...valid, manifests: [{ digest: descriptor.digest }] },
  ]) {
    expect(() =>
      parseRemoteRunnerManifest(
        `Pushed image: ${remote}`,
        JSON.stringify(manifest),
        tag,
        descriptor.digest,
      ),
    ).toThrow("runner_image_remote_manifest_invalid");
  }
});

test("remote manifest requires Docker 29 Descriptor.platform and rejects ambiguous platform or uploaded bytes", () => {
  const tag = createRunnerTransportTag(
    COMMIT,
    DOCKERFILE_DIGEST,
    "01".repeat(16),
  );
  const remote = `registry.cloudflare.com/${"c".repeat(32)}/takosumi-runner:${tag}`;
  const inspect = (overrides: Record<string, unknown>) =>
    JSON.stringify({
      Descriptor: {
        mediaType: "application/vnd.docker.distribution.manifest.v2+json",
        digest: `sha256:${"e".repeat(64)}`,
        platform: { architecture: "amd64", os: "linux" },
      },
      SchemaV2Manifest: {
        schemaVersion: 2,
        mediaType: "application/vnd.docker.distribution.manifest.v2+json",
        config: { digest: `sha256:${"f".repeat(64)}` },
      },
      ...overrides,
    });

  for (const manifest of [
    inspect({
      Descriptor: { digest: `sha256:${"e".repeat(64)}` },
      Platform: { architecture: "amd64", os: "linux" },
    }),
    inspect({ Platform: { architecture: "amd64", os: "linux" } }),
    inspect({
      Descriptor: {
        digest: `sha256:${"e".repeat(64)}`,
        platform: { architecture: "amd64", os: "linux" },
      },
    }),
    inspect({
      SchemaV2Manifest: {
        schemaVersion: 2,
        config: { digest: `sha256:${"f".repeat(64)}` },
      },
    }),
    inspect({
      Descriptor: {
        mediaType: "application/vnd.docker.distribution.manifest.v2+json",
        digest: `sha256:${"e".repeat(64)}`,
        platform: { architecture: "arm64", os: "linux" },
      },
    }),
    inspect({
      Descriptor: {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: `sha256:${"e".repeat(64)}`,
        platform: { architecture: "amd64", os: "linux" },
      },
    }),
    inspect({
      SchemaV2Manifest: {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: { digest: `sha256:${"f".repeat(64)}` },
      },
    }),
    inspect({ manifests: [{ digest: `sha256:${"1".repeat(64)}` }] }),
  ]) {
    expect(() =>
      parseRemoteRunnerManifest(
        `Pushed image: ${remote}`,
        manifest,
        tag,
        `sha256:${"e".repeat(64)}`,
      ),
    ).toThrow("runner_image_remote_manifest_invalid");
  }
  expect(() =>
    parseRemoteRunnerManifest(
      `Pushed image: ${remote}`,
      inspect({}),
      tag,
      `sha256:${"0".repeat(64)}`,
    ),
  ).toThrow("runner_image_remote_content_mismatch");
});
