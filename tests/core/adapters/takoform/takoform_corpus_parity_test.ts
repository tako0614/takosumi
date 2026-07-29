import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TAKOFORM_PACKAGE_ENVELOPE_MEDIA_TYPE,
  TakoformDataOnlyPackageVerifier,
} from "../../../../core/adapters/takoform/package_verifier.ts";
import {
  canonicalJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from "../../../../core/adapters/takoform/canonical_json.ts";
import { sha256HexAsync } from "../../../../core/shared/runtime/hash.ts";
import { portableTypeForShapeKind } from "takosumi-contract";

/**
 * Cross-implementation parity trip-wire (spec/GOVERNANCE.md in takoform):
 * takoform's conformance corpus is the single source of verifier verdicts,
 * and this host's verifier must agree with the Go verifier on every case.
 * A rule added on one side without a corpus case — or a divergent verdict —
 * fails here. The corpus lives in the sibling takoform checkout; when that
 * checkout is absent (isolated CI), the suite is skipped loudly.
 */
const TAKOFORM_ROOT = "/root/dev/takos/takoform";
const CORPUS_ROOT = join(TAKOFORM_ROOT, "conformance", "form-package-v1");
const corpusPresent = existsSync(join(CORPUS_ROOT, "manifest.json"));

const acceptingSignature = {
  id: "parity-accepting",
  verify: async () => {},
};

interface EnvelopeFile {
  readonly path: string;
  readonly mode: number;
  readonly contentBase64: string;
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function envelopeFromIndex(
  indexBytes: Uint8Array,
  files: readonly EnvelopeFile[],
): Promise<{ envelope: Uint8Array; packageDigest: string }> {
  const canonicalIndex = canonicalJsonBytes(parseCanonicalJson(indexBytes));
  const packageDigest = `sha256:${await sha256HexAsync(canonicalIndex)}`;
  const envelope = canonicalJsonBytes({
    mediaType: TAKOFORM_PACKAGE_ENVELOPE_MEDIA_TYPE,
    packageIndexBase64: encodeBase64(indexBytes),
    files: files as unknown as CanonicalJsonValue,
    sigstoreBundle: { parity: true },
  });
  return { envelope, packageDigest };
}

/** Builds the install envelope for an on-disk takoform corpus package. */
async function envelopeFromDirectory(directory: string) {
  const indexBytes = new Uint8Array(
    readFileSync(join(directory, "package-index.json")),
  );
  const index = parseCanonicalJson(indexBytes) as {
    readonly files: readonly { readonly path: string }[];
  };
  const files: EnvelopeFile[] = index.files.map((entry) => ({
    path: entry.path,
    mode: 0o644,
    contentBase64: encodeBase64(
      new Uint8Array(readFileSync(join(directory, entry.path))),
    ),
  }));
  return envelopeFromIndex(indexBytes, files);
}

const DEFINITION_MEDIA_TYPE =
  "application/vnd.takoform.form-definition.v1+json";

async function fileEntry(path: string, mediaType: string, bytes: Uint8Array) {
  return {
    path,
    mediaType,
    size: bytes.byteLength,
    digest: `sha256:${await sha256HexAsync(bytes)}`,
  };
}

/**
 * Synthesizes a one-definition package around the given definition value,
 * plus optional extra payload files, mirroring the Go corpus operations that
 * exercise fragments rather than whole packages.
 */
async function syntheticPackage(
  definition: CanonicalJsonValue,
  extraFiles: readonly {
    path: string;
    mediaType: string;
    bytes: Uint8Array;
  }[] = [],
) {
  const definitionBytes = canonicalJsonBytes(definition);
  const record = definition as Readonly<Record<string, CanonicalJsonValue>>;
  const entries = [
    await fileEntry("definition.json", DEFINITION_MEDIA_TYPE, definitionBytes),
  ];
  for (const extra of extraFiles) {
    entries.push(await fileEntry(extra.path, extra.mediaType, extra.bytes));
  }
  const index = {
    apiVersion: "packages.forms.takoform.com/v1alpha1",
    kind: "FormPackage",
    packageVersion: String(record.definitionVersion ?? "1.0.0"),
    formRef: {
      apiVersion: "forms.takoform.com/v1alpha1",
      kind: String(record.kind ?? "ParityProbe"),
      definitionVersion: String(record.definitionVersion ?? "1.0.0"),
      schemaDigest: `sha256:${await sha256HexAsync(definitionBytes)}`,
    },
    definitionPath: "definition.json",
    files: entries.sort((left, right) => left.path.localeCompare(right.path)),
  };
  const files: EnvelopeFile[] = [
    {
      path: "definition.json",
      mode: 0o644,
      contentBase64: encodeBase64(definitionBytes),
    },
    ...extraFiles.map((extra) => ({
      path: extra.path,
      mode: 0o644,
      contentBase64: encodeBase64(extra.bytes),
    })),
  ];
  return envelopeFromIndex(canonicalJsonBytes(index), files);
}

function minimalDefinition(
  overrides: Readonly<Record<string, CanonicalJsonValue>> = {},
): CanonicalJsonValue {
  return {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ParityProbe",
    definitionVersion: "1.0.0",
    title: "Parity probe",
    status: "standard",
    desiredSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string" } },
    },
    observedSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: { ready: { type: "boolean" } },
    },
    lifecycleCapabilities: ["create", "read"],
    ...overrides,
  };
}

interface CorpusManifest {
  readonly positive: readonly {
    readonly name: string;
    readonly path: string;
    readonly kind: string;
  }[];
  readonly negative: readonly {
    readonly name: string;
    readonly operation: string;
    readonly path?: string;
    readonly value?: string;
  }[];
}

describe.skipIf(!corpusPresent)("takoform corpus parity", () => {
  const manifest = corpusPresent
    ? (JSON.parse(
        readFileSync(join(CORPUS_ROOT, "manifest.json"), "utf8"),
      ) as CorpusManifest)
    : { positive: [], negative: [] };
  const verifier = new TakoformDataOnlyPackageVerifier(acceptingSignature);
  const standardPins = corpusPresent
    ? (JSON.parse(
        readFileSync(
          join(TAKOFORM_ROOT, "forms", "standard-package-set.json"),
          "utf8",
        ),
      ) as {
        readonly packages: readonly {
          readonly kind: string;
          readonly packageDigest: string;
        }[];
      })
    : { packages: [] };

  test("harness control: a minimal synthetic package verifies", async () => {
    const control = await syntheticPackage(minimalDefinition());
    const verified = await verifier.verify(
      control.envelope,
      control.packageDigest,
    );
    expect(verified.definitions[0]?.formRef.type).toBe("parity_probe");
  });

  for (const positive of manifest.positive) {
    test(`positive verdict parity: ${positive.name}`, async () => {
      const built = await envelopeFromDirectory(
        join(CORPUS_ROOT, positive.path),
      );
      const verified = await verifier.verify(
        built.envelope,
        built.packageDigest,
      );
      expect(verified.packageDigest).toBe(built.packageDigest);
      expect(verified.definitions[0]?.formRef.type).toBe(
        portableTypeForShapeKind(positive.kind),
      );
      const pinned = standardPins.packages.find(
        (entry) => entry.kind === positive.kind,
      );
      if (pinned && positive.name.startsWith("standard-")) {
        // Digest parity with the Go-computed release pin, not just self-consistency.
        expect(built.packageDigest).toBe(pinned.packageDigest);
      }
    });
  }

  for (const negative of manifest.negative) {
    test(`negative verdict parity: ${negative.name} (${negative.operation})`, async () => {
      let build: Promise<{ envelope: Uint8Array; packageDigest: string }>;
      switch (negative.operation) {
        case "definition": {
          const raw = readFileSync(join(CORPUS_ROOT, negative.path!), "utf8");
          build = syntheticPackage(JSON.parse(raw) as CanonicalJsonValue);
          break;
        }
        case "schema-policy": {
          const raw = readFileSync(join(CORPUS_ROOT, negative.path!), "utf8");
          build = syntheticPackage(
            minimalDefinition({
              desiredSchema: {
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                additionalProperties: false,
                properties: { probe: JSON.parse(raw) as CanonicalJsonValue },
              },
            }),
          );
          break;
        }
        case "content-policy": {
          const bytes = new Uint8Array(
            readFileSync(join(CORPUS_ROOT, negative.path!)),
          );
          build = syntheticPackage(minimalDefinition(), [
            { path: "payload.json", mediaType: "application/json", bytes },
          ]);
          break;
        }
        case "canonicalize": {
          const bytes = new Uint8Array(
            readFileSync(join(CORPUS_ROOT, negative.path!)),
          );
          build = syntheticPackage(minimalDefinition(), [
            { path: "payload.json", mediaType: "application/json", bytes },
          ]);
          break;
        }
        case "package-path": {
          const probe = new TextEncoder().encode("{}\n");
          build = syntheticPackage(minimalDefinition(), [
            {
              path: negative.value!,
              mediaType: "application/json",
              bytes: probe,
            },
          ]);
          break;
        }
        default:
          throw new Error(`unknown corpus operation ${negative.operation}`);
      }
      const built = await build.catch((error: unknown) => error);
      if (built instanceof Error) {
        // Rejected while even constructing the canonical envelope — that is
        // a rejection verdict too (e.g. non-canonicalizable payload bytes).
        return;
      }
      const outcome = verifier.verify(
        (built as { envelope: Uint8Array }).envelope,
        (built as { packageDigest: string }).packageDigest,
      );
      await expect(outcome).rejects.toThrow();
    });
  }
});
