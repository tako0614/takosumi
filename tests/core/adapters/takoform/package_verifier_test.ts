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
  const definition = await registry.getDefinition(artifact.formRef);
  expect(definition?.operations).toEqual([
    "create",
    "update",
    "read",
    "refresh",
    "delete",
    "import",
  ]);
  expect(definition?.interfaceDescriptors).toEqual([
    {
      name: "storage.object",
      version: "v1",
      required: true,
      document: { protocol: "https" },
      documentSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        properties: { protocol: { const: "https" } },
        required: ["protocol"],
      },
      inputs: [{ name: "bucket", source: "output", pointer: "/bucket_name" }],
    },
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

test("output and negative fixtures are verified against their declared schemas", async () => {
  const verifier = new TakoformDataOnlyPackageVerifier(
    new AcceptingSignatureVerifier(),
  );
  const valid = await buildArtifact(undefined, {
    fixture: { name: "store" },
    observedFixture: { endpoint: "https://store.example" },
    outputFixture: { url: "https://store.example" },
    negativeFixture: {},
    negativeStage: "output",
  });
  const verified = await verifier.verify(valid.envelope, valid.packageDigest);
  expect(verified.definitions[0]?.operations).toEqual([
    "create",
    "update",
    "read",
    "refresh",
    "delete",
    "import",
  ]);

  const invalidOutput = await buildArtifact(undefined, {
    fixture: { name: "store" },
    outputFixture: {},
  });
  await expect(
    verifier.verify(invalidOutput.envelope, invalidOutput.packageDigest),
  ).rejects.toThrow("does not satisfy outputSchema");

  const passingNegative = await buildArtifact(undefined, {
    negativeFixture: { name: "valid" },
    negativeStage: "desired",
  });
  await expect(
    verifier.verify(passingNegative.envelope, passingNegative.packageDigest),
  ).rejects.toThrow("unexpectedly passed desired validation");

  const unsupportedFailure = await buildArtifact(undefined, {
    negativeFixture: {},
    negativeStage: "desired",
    negativeExpectedFailure: "invalid_argument",
  });
  await expect(
    verifier.verify(
      unsupportedFailure.envelope,
      unsupportedFailure.packageDigest,
    ),
  ).rejects.toThrow("unsupported expectedFailure");
});

test("definition semantics reject duplicate Interface and fixture identities", async () => {
  const verifier = new TakoformDataOnlyPackageVerifier(
    new AcceptingSignatureVerifier(),
  );
  const duplicateInterface = await buildArtifact((definition) => ({
    ...(definition as Record<string, CanonicalJsonValue>),
    interfaces: [
      { name: "storage.object", version: "v1" },
      {
        name: "storage.object",
        version: "v1",
        description: "same semantic identity",
      },
    ],
  }));
  await expect(
    verifier.verify(
      duplicateInterface.envelope,
      duplicateInterface.packageDigest,
    ),
  ).rejects.toThrow("duplicate Interface storage.object@v1");

  const duplicateFixture = await buildArtifact(
    (definition) => {
      const value = definition as Record<string, CanonicalJsonValue>;
      const negative = value.negativeConformanceFixtures as Array<
        Record<string, CanonicalJsonValue>
      >;
      return {
        ...value,
        negativeConformanceFixtures: [{ ...negative[0], name: "positive" }],
      };
    },
    {
      fixture: { name: "valid" },
      negativeFixture: {},
    },
  );
  await expect(
    verifier.verify(duplicateFixture.envelope, duplicateFixture.packageDigest),
  ).rejects.toThrow("duplicate conformance fixture name positive");
});

test("Interface descriptor versions coexist and exact documents fail closed", async () => {
  const verifier = new TakoformDataOnlyPackageVerifier(
    new AcceptingSignatureVerifier(),
  );
  const versioned = await buildArtifact((definition) => ({
    ...asRecord(definition),
    interfaces: [
      ...((asRecord(definition).interfaces as CanonicalJsonValue[]) ?? []),
      { name: "storage.object", version: "v2" },
    ],
  }));
  const verified = await verifier.verify(
    versioned.envelope,
    versioned.packageDigest,
  );
  expect(
    verified.definitions[0]?.interfaceDescriptors?.map((descriptor) => [
      descriptor.name,
      descriptor.version,
    ]),
  ).toEqual([
    ["storage.object", "v1"],
    ["storage.object", "v2"],
  ]);

  const invalidDocument = await buildArtifact((definition) => ({
    ...asRecord(definition),
    interfaces: [
      {
        name: "storage.object",
        version: "v1",
        document: { protocol: "http" },
        documentSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          additionalProperties: false,
          properties: { protocol: { const: "https" } },
          required: ["protocol"],
        },
      },
    ],
  }));
  await expect(
    verifier.verify(invalidDocument.envelope, invalidDocument.packageDigest),
  ).rejects.toThrow("document does not satisfy documentSchema");

  const invalidPointer = await buildArtifact((definition) => ({
    ...asRecord(definition),
    interfaces: [
      {
        name: "storage.object",
        version: "v1",
        inputs: [{ name: "bucket", source: "output", pointer: "/bad~2" }],
      },
    ],
  }));
  await expect(
    verifier.verify(invalidPointer.envelope, invalidPointer.packageDigest),
  ).rejects.toThrow("pointer must match pattern");
});

async function buildArtifact(
  mutateDefinition?: (definition: CanonicalJsonValue) => CanonicalJsonValue,
  options: {
    readonly mode?: number;
    readonly extraFile?: boolean;
    readonly schemaDigestOverride?: string;
    readonly definitionPath?: string;
    readonly fixture?: CanonicalJsonValue;
    readonly observedFixture?: CanonicalJsonValue;
    readonly outputFixture?: CanonicalJsonValue;
    readonly negativeFixture?: CanonicalJsonValue;
    readonly negativeStage?: "desired" | "observed" | "output";
    readonly negativeExpectedFailure?: string;
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
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
    immutableFields: ["/name"],
    lifecycleCapabilities: [
      "create",
      "update",
      "read",
      "refresh",
      "delete",
      "import",
      "observe",
      "drift",
    ],
    interfaces: [
      {
        name: "storage.object",
        version: "v1",
        required: true,
        document: { protocol: "https" },
        documentSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          additionalProperties: false,
          properties: { protocol: { const: "https" } },
          required: ["protocol"],
        },
        inputs: [{ name: "bucket", source: "output", pointer: "/bucket_name" }],
      },
    ],
    ...(options.fixture !== undefined
      ? {
          conformanceFixtures: [
            {
              name: "positive",
              desiredPath: "fixture.json",
              ...(options.observedFixture !== undefined
                ? { observedPath: "observed.json" }
                : {}),
              ...(options.outputFixture !== undefined
                ? { outputPath: "output.json" }
                : {}),
            },
          ],
        }
      : {}),
    ...(options.negativeFixture !== undefined
      ? {
          negativeConformanceFixtures: [
            {
              name: "negative",
              stage: options.negativeStage ?? "desired",
              inputPath: "negative.json",
              expectedFailure:
                options.negativeExpectedFailure ?? "schema_validation_failed",
            },
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
  const fixturePayloads: Array<{
    readonly path: string;
    readonly bytes: Uint8Array;
  }> = [];
  const addFixture = (path: string, value: CanonicalJsonValue | undefined) => {
    if (value !== undefined) {
      fixturePayloads.push({ path, bytes: canonicalJsonBytes(value) });
    }
  };
  addFixture("fixture.json", options.fixture);
  addFixture("negative.json", options.negativeFixture);
  addFixture("observed.json", options.observedFixture);
  addFixture("output.json", options.outputFixture);
  fixturePayloads.sort((left, right) => left.path.localeCompare(right.path));
  const fixtureIndexEntries = await Promise.all(
    fixturePayloads.map(async ({ path, bytes }) => ({
      path,
      mediaType: "application/json",
      size: bytes.byteLength,
      digest: `sha256:${await sha256HexAsync(bytes)}`,
    })),
  );
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
      ...fixtureIndexEntries,
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
    ...fixturePayloads.map(({ path, bytes }) => ({
      path,
      mode: 0o644,
      contentBase64: encodeBase64(bytes),
    })),
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
