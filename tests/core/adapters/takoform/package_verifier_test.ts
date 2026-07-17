import { expect, test } from "bun:test";
import {
  FormRegistryService,
  InMemoryFormRegistryStore,
} from "../../../../core/domains/service-forms/mod.ts";
import {
  canonicalJsonBytes,
  type CanonicalJsonValue,
} from "../../../../core/adapters/takoform/canonical_json.ts";
import {
  TAKOFORM_PACKAGE_ENVELOPE_MEDIA_TYPE,
  TakoformDataOnlyPackageVerifier,
} from "../../../../core/adapters/takoform/package_verifier.ts";
import type { TakoformPackageSignatureVerifier } from "../../../../core/adapters/takoform/signature.ts";
import { sha256HexAsync } from "../../../../core/shared/runtime/hash.ts";

class AcceptingSignatureVerifier implements TakoformPackageSignatureVerifier {
  readonly id = "test.sigstore.v1";
  calls = 0;

  async verify(canonicalIndex: Uint8Array, signatureBundle: unknown) {
    this.calls++;
    if (canonicalIndex.byteLength === 0 || !isRecord(signatureBundle)) {
      throw new TypeError("invalid test signature");
    }
    return {
      oidcIssuer: "https://token.actions.githubusercontent.com",
      certificateIdentity:
        "https://github.com/tako0614/terraform-provider-takoform/.github/workflows/form-package-release.yml@refs/tags/forms/example-store/v1.0.0",
      sourceRepository: "tako0614/terraform-provider-takoform",
      workflow: ".github/workflows/form-package-release.yml",
      ref: "refs/tags/forms/example-store/v1.0.0",
    };
  }
}

class RejectingSignatureVerifier implements TakoformPackageSignatureVerifier {
  readonly id = "test.reject.v1";
  async verify(): Promise<never> {
    throw new TypeError("signature rejected");
  }
}

test("a signed exact data-only package reaches the durable Form Registry seam", async () => {
  const signature = new AcceptingSignatureVerifier();
  const artifact = await buildArtifact();
  const registry = new FormRegistryService({
    store: new InMemoryFormRegistryStore(),
    artifactReader: { read: async () => artifact.envelope },
    verifier: new TakoformDataOnlyPackageVerifier(signature),
    now: () => "2026-07-17T00:00:00.000Z",
  });

  const installed = await registry.installPackage({
    artifactRef: "r2:packages/example-store-v1.json",
    expectedPackageDigest: artifact.packageDigest,
    actorId: "operator:test",
  });

  expect(signature.calls).toBe(1);
  expect(installed.packageDigest).toBe(artifact.packageDigest);
  expect(installed.verifierId).toBe(
    "takoform.form-package.v1alpha1+test.sigstore.v1",
  );
  expect(installed.definitionRefs).toEqual([artifact.formRef]);
  expect((await registry.getDefinition(artifact.formRef))?.operations).toEqual([
    "create",
    "update",
    "read",
    "refresh",
    "delete",
    "import",
  ]);
});

test("package digest and Sigstore verification fail closed before install", async () => {
  const artifact = await buildArtifact();
  const verifier = new TakoformDataOnlyPackageVerifier(
    new AcceptingSignatureVerifier(),
  );
  await expect(
    verifier.verify(artifact.envelope, `sha256:${"0".repeat(64)}`),
  ).rejects.toThrow("package digest mismatch");
  await expect(
    new TakoformDataOnlyPackageVerifier(
      new RejectingSignatureVerifier(),
    ).verify(artifact.envelope, artifact.packageDigest),
  ).rejects.toThrow("signature rejected");
});

test("schema identity, data-only fields, executable modes, and payload closure reject independently", async () => {
  const signature = new AcceptingSignatureVerifier();
  const verifier = new TakoformDataOnlyPackageVerifier(signature);

  const openSchema = await buildArtifact((definition) => ({
    ...definition,
    desiredSchema: {
      ...asRecord(definition.desiredSchema),
      additionalProperties: true,
    },
  }));
  await expect(
    verifier.verify(openSchema.envelope, openSchema.packageDigest),
  ).rejects.toThrow("not explicitly closed");

  const credential = await buildArtifact((definition) => ({
    ...definition,
    desiredSchema: {
      ...asRecord(definition.desiredSchema),
      properties: {
        apiKey: { type: "string" },
      },
    },
  }));
  await expect(
    verifier.verify(credential.envelope, credential.packageDigest),
  ).rejects.toThrow("forbidden field apiKey");

  const lowercaseCredential = await buildArtifact((definition) => ({
    ...definition,
    desiredSchema: {
      ...asRecord(definition.desiredSchema),
      properties: {
        credentialid: { type: "string" },
      },
    },
  }));
  await expect(
    verifier.verify(
      lowercaseCredential.envelope,
      lowercaseCredential.packageDigest,
    ),
  ).rejects.toThrow("forbidden field credentialid");

  const mediaMismatch = await buildArtifact(undefined, {
    definitionPath: "definition.txt",
  });
  await expect(
    verifier.verify(mediaMismatch.envelope, mediaMismatch.packageDigest),
  ).rejects.toThrow("extension does not match");

  const forbiddenFixture = await buildArtifact(undefined, {
    fixture: { credentialid: "not-package-data" },
  });
  await expect(
    verifier.verify(forbiddenFixture.envelope, forbiddenFixture.packageDigest),
  ).rejects.toThrow("forbidden field credentialid");

  const executable = await buildArtifact(undefined, { mode: 0o755 });
  await expect(
    verifier.verify(executable.envelope, executable.packageDigest),
  ).rejects.toThrow("is executable");

  const extra = await buildArtifact(undefined, { extraFile: true });
  await expect(
    verifier.verify(extra.envelope, extra.packageDigest),
  ).rejects.toThrow("missing or unlisted payloads");

  const mismatchedRef = await buildArtifact(undefined, {
    schemaDigestOverride: `sha256:${"f".repeat(64)}`,
  });
  await expect(
    verifier.verify(mismatchedRef.envelope, mismatchedRef.packageDigest),
  ).rejects.toThrow("FormRef does not match");
});

test("strict I-JSON rejects duplicate names and negative zero", async () => {
  const verifier = new TakoformDataOnlyPackageVerifier(
    new AcceptingSignatureVerifier(),
  );
  await expect(
    verifier.verify(
      new TextEncoder().encode(
        '{"mediaType":"x","mediaType":"y","packageIndexBase64":"","files":[],"sigstoreBundle":{}}',
      ),
      `sha256:${"0".repeat(64)}`,
    ),
  ).rejects.toThrow("duplicate JSON object name");
  await expect(
    verifier.verify(
      new TextEncoder().encode(
        `{"mediaType":"${TAKOFORM_PACKAGE_ENVELOPE_MEDIA_TYPE}","packageIndexBase64":"","files":[],"sigstoreBundle":{"value":-0}}`,
      ),
      `sha256:${"0".repeat(64)}`,
    ),
  ).rejects.toThrow("negative zero");
  await expect(
    verifier.verify(
      canonicalJsonBytes({
        mediaType: TAKOFORM_PACKAGE_ENVELOPE_MEDIA_TYPE,
        packageIndexBase64: "AB==",
        files: [],
        sigstoreBundle: {},
      }),
      `sha256:${"0".repeat(64)}`,
    ),
  ).rejects.toThrow("not canonical base64");
});

async function buildArtifact(
  mutateDefinition?: (definition: CanonicalJsonValue) => CanonicalJsonValue,
  options: {
    readonly mode?: number;
    readonly extraFile?: boolean;
    readonly schemaDigestOverride?: string;
    readonly definitionPath?: string;
    readonly fixture?: CanonicalJsonValue;
  } = {},
) {
  const originalDefinition: CanonicalJsonValue = {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ExampleStore",
    definitionVersion: "1.0.0",
    title: "Example Store",
    description: "Portable data-only store.",
    status: "compatibility-candidate",
    desiredSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1 },
      },
      required: ["name"],
    },
    observedSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        endpoint: { type: "string" },
      },
    },
    immutableFields: ["/name"],
    lifecycleCapabilities: ["create", "update", "observe", "delete", "import"],
    ...(options.fixture !== undefined
      ? {
          conformanceFixtures: [
            { name: "positive", desiredPath: "fixture.json" },
          ],
        }
      : {}),
  };
  const definition =
    mutateDefinition?.(originalDefinition) ?? originalDefinition;
  const definitionBytes = canonicalJsonBytes(definition);
  const schemaDigest =
    options.schemaDigestOverride ??
    `sha256:${await sha256HexAsync(definitionBytes)}`;
  const formRef = {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ExampleStore",
    definitionVersion: "1.0.0",
    schemaDigest,
  };
  const definitionPath = options.definitionPath ?? "definition.json";
  const fixtureBytes =
    options.fixture === undefined
      ? undefined
      : canonicalJsonBytes(options.fixture);
  const index: CanonicalJsonValue = {
    apiVersion: "packages.forms.takoform.com/v1alpha1",
    kind: "FormPackage",
    packageVersion: "1.0.0",
    formRef,
    definitionPath,
    files: [
      {
        path: definitionPath,
        mediaType: "application/vnd.takoform.form-definition.v1+json",
        size: definitionBytes.byteLength,
        digest: `sha256:${await sha256HexAsync(definitionBytes)}`,
      },
      ...(fixtureBytes
        ? [
            {
              path: "fixture.json",
              mediaType: "application/json",
              size: fixtureBytes.byteLength,
              digest: `sha256:${await sha256HexAsync(fixtureBytes)}`,
            },
          ]
        : []),
    ],
  };
  const indexBytes = canonicalJsonBytes(index);
  const packageDigest = `sha256:${await sha256HexAsync(indexBytes)}`;
  const files: CanonicalJsonValue[] = [
    {
      path: definitionPath,
      mode: options.mode ?? 0o644,
      contentBase64: encodeBase64(definitionBytes),
    },
    ...(fixtureBytes
      ? [
          {
            path: "fixture.json",
            mode: 0o644,
            contentBase64: encodeBase64(fixtureBytes),
          },
        ]
      : []),
  ];
  if (options.extraFile) {
    files.push({ path: "extra.txt", mode: 0o644, contentBase64: "" });
  }
  const envelope = canonicalJsonBytes({
    mediaType: TAKOFORM_PACKAGE_ENVELOPE_MEDIA_TYPE,
    packageIndexBase64: encodeBase64(indexBytes),
    files,
    sigstoreBundle: { test: true },
  });
  return { envelope, packageDigest, formRef };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(
  value: CanonicalJsonValue,
): Readonly<Record<string, CanonicalJsonValue>> {
  if (!isRecord(value)) throw new TypeError("expected record");
  return value as Readonly<Record<string, CanonicalJsonValue>>;
}
