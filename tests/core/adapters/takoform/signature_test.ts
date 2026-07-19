import { expect, test } from "bun:test";
import { bundleFromJSON } from "@sigstore/bundle";
import { PublicKeyDetails, TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity } from "@sigstore/verify";
import { verifyTLogBody } from "@sigstore/verify/dist/tlog";
import { createHash } from "node:crypto";

import { SigstoreTakoformPackageSignatureVerifier } from "../../../../core/adapters/takoform/signature.ts";

const fixtureRoot = new URL(
  "../../../fixtures/takoform-sigstore/",
  import.meta.url,
);
async function readBase64Fixture(name: string): Promise<Uint8Array> {
  const encoded = await Bun.file(new URL(`${name}.base64`, fixtureRoot)).text();
  return Buffer.from(encoded.replace(/\s/gu, ""), "base64");
}

const packageIndex = await readBase64Fixture("package-index.json");
const bundleFixture = JSON.parse(
  new TextDecoder().decode(
    await readBase64Fixture("package-index.sigstore.json"),
  ),
) as Record<string, any>;
const trustedRootBytes = new Uint8Array(
  await Bun.file(new URL("trusted-root.json", fixtureRoot)).arrayBuffer(),
);
const trustedRootJson = JSON.parse(
  new TextDecoder().decode(trustedRootBytes),
) as Record<string, any>;
const trustedRootDigest = `sha256:${createHash("sha256")
  .update(trustedRootBytes)
  .digest("hex")}` as const;
const zeroDigest = `sha256:${"0".repeat(64)}` as const;

const publisher = {
  oidcIssuer: "https://token.actions.githubusercontent.com",
  sourceRepository: "tako0614/terraform-provider-takoform",
  workflow: ".github/workflows/form-package-release.yml",
  refPattern: "refs/heads/main",
} as const;

function fixtureVerifier(
  input: {
    root?: Record<string, any>;
    refPattern?: string;
  } = {},
) {
  const root = input.root ?? trustedRootJson;
  const bytes = new TextEncoder().encode(JSON.stringify(root));
  const digest =
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  return new SigstoreTakoformPackageSignatureVerifier({
    trustedRootDigest: digest,
    loadTrustedRoot: async () => bytes,
    publishers: [
      { ...publisher, refPattern: input.refPattern ?? publisher.refPattern },
    ],
  });
}

function flipBase64(value: string): string {
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength === 0) throw new Error("fixture value is empty");
  bytes[bytes.byteLength - 1] = bytes[bytes.byteLength - 1]! ^ 1;
  return bytes.toString("base64");
}

test("Sigstore package policy requires a digest-pinned explicit publisher", () => {
  expect(
    () =>
      new SigstoreTakoformPackageSignatureVerifier({
        trustedRootDigest: zeroDigest,
        loadTrustedRoot: async () => new Uint8Array(),
        publishers: [],
      }),
  ).toThrow("at least one trusted Takoform publisher");

  expect(
    () =>
      new SigstoreTakoformPackageSignatureVerifier({
        trustedRootDigest: zeroDigest,
        loadTrustedRoot: async () => new Uint8Array(),
        publishers: [publisher],
      }),
  ).not.toThrow();

  expect(
    () =>
      new SigstoreTakoformPackageSignatureVerifier({
        trustedRootDigest: zeroDigest,
        loadTrustedRoot: async () => new Uint8Array(),
        publishers: [{ ...publisher, refPattern: "refs/heads/*" }],
      }),
  ).toThrow("exact branch ref");

  expect(
    () =>
      new SigstoreTakoformPackageSignatureVerifier({
        trustedRootDigest: zeroDigest,
        loadTrustedRoot: async () => new Uint8Array(),
        publishers: [
          {
            oidcIssuer: publisher.oidcIssuer,
            sourceRepository: publisher.sourceRepository,
            workflow: publisher.workflow,
            tagPattern: "refs/tags/forms-*",
          },
        ],
      }),
  ).not.toThrow();
});

test("malformed Sigstore material fails before a trust root can be used", async () => {
  let trustedRootReads = 0;
  const verifier = new SigstoreTakoformPackageSignatureVerifier({
    trustedRootDigest: zeroDigest,
    loadTrustedRoot: async () => {
      trustedRootReads++;
      return new Uint8Array();
    },
    publishers: [publisher],
  });

  await expect(verifier.verify(new Uint8Array([1]), {})).rejects.toThrow(
    "invalid Sigstore v0.3 bundle",
  );
  expect(trustedRootReads).toBe(0);
});

test("retained Takoform Sigstore fixture verifies offline", async () => {
  const result = await fixtureVerifier().verify(packageIndex, bundleFixture);
  expect(result).toEqual({
    oidcIssuer: publisher.oidcIssuer,
    certificateIdentity:
      "https://github.com/tako0614/terraform-provider-takoform/.github/workflows/form-package-release.yml@refs/heads/main",
    sourceRepository: publisher.sourceRepository,
    workflow: publisher.workflow,
    ref: "refs/heads/main",
  });
  expect(trustedRootDigest).toBe(
    "sha256:6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66",
  );
});

test("retained fixture rejects transparency, bundle, validity, subject, and identity mutations", async () => {
  const cases: readonly {
    readonly name: string;
    readonly mutate: (
      bundle: Record<string, any>,
      root: Record<string, any>,
      subject: Uint8Array,
    ) => {
      bundle?: Record<string, any>;
      root?: Record<string, any>;
      subject?: Uint8Array;
      refPattern?: string;
    } | void;
  }[] = [
    {
      name: "log ID",
      mutate: (bundle) => {
        bundle.verificationMaterial.tlogEntries[0].logId.keyId = flipBase64(
          bundle.verificationMaterial.tlogEntries[0].logId.keyId,
        );
      },
    },
    {
      name: "integrated time",
      mutate: (bundle) => {
        const entry = bundle.verificationMaterial.tlogEntries[0];
        entry.integratedTime = String(BigInt(entry.integratedTime) + 1n);
      },
    },
    {
      name: "outer log index",
      mutate: (bundle) => {
        const entry = bundle.verificationMaterial.tlogEntries[0];
        entry.logIndex = String(BigInt(entry.logIndex) + 1n);
      },
    },
    {
      name: "canonical body",
      mutate: (bundle) => {
        const entry = bundle.verificationMaterial.tlogEntries[0];
        const body = Buffer.from(entry.canonicalizedBody, "base64")
          .toString("utf8")
          .replace('"apiVersion":"0.0.1"', '"apiVersion":"0.0.2"');
        entry.canonicalizedBody = Buffer.from(body).toString("base64");
      },
    },
    {
      name: "certificate",
      mutate: (bundle) => {
        bundle.verificationMaterial.certificate.rawBytes = flipBase64(
          bundle.verificationMaterial.certificate.rawBytes,
        );
      },
    },
    {
      name: "bundle signature",
      mutate: (bundle) => {
        bundle.messageSignature.signature = flipBase64(
          bundle.messageSignature.signature,
        );
      },
    },
    {
      name: "proof index",
      mutate: (bundle) => {
        const proof = bundle.verificationMaterial.tlogEntries[0].inclusionProof;
        proof.logIndex = String(BigInt(proof.logIndex) + 1n);
      },
    },
    {
      name: "proof hash",
      mutate: (bundle) => {
        const proof = bundle.verificationMaterial.tlogEntries[0].inclusionProof;
        proof.hashes[0] = flipBase64(proof.hashes[0]);
      },
    },
    {
      name: "proof root",
      mutate: (bundle) => {
        const proof = bundle.verificationMaterial.tlogEntries[0].inclusionProof;
        proof.rootHash = flipBase64(proof.rootHash);
      },
    },
    {
      name: "checkpoint",
      mutate: (bundle) => {
        const checkpoint =
          bundle.verificationMaterial.tlogEntries[0].inclusionProof.checkpoint;
        checkpoint.envelope = checkpoint.envelope.replace(
          "2073666978",
          "2073666979",
        );
      },
    },
    {
      name: "missing SET",
      mutate: (bundle) => {
        delete bundle.verificationMaterial.tlogEntries[0].inclusionPromise;
      },
    },
    {
      name: "missing proof",
      mutate: (bundle) => {
        delete bundle.verificationMaterial.tlogEntries[0].inclusionProof;
      },
    },
    {
      name: "key validity",
      mutate: (_bundle, root) => {
        root.tlogs[0].publicKey.validFor.end = "2022-01-01T00:00:00Z";
      },
    },
    {
      name: "signed subject",
      mutate: (_bundle, _root, subject) => {
        const changed = subject.slice();
        changed[changed.byteLength - 1] = changed[changed.byteLength - 1]! ^ 1;
        return { subject: changed };
      },
    },
    {
      name: "publisher identity",
      mutate: () => ({ refPattern: "refs/tags/forms-*" }),
    },
  ];

  for (const testCase of cases) {
    const bundle = structuredClone(bundleFixture);
    const root = structuredClone(trustedRootJson);
    const changes = testCase.mutate(bundle, root, packageIndex) ?? {};
    let rejected = false;
    try {
      await fixtureVerifier({
        root: changes.root ?? root,
        refPattern: changes.refPattern,
      }).verify(changes.subject ?? packageIndex, changes.bundle ?? bundle);
    } catch {
      rejected = true;
    }
    expect(rejected, testCase.name).toBe(true);
  }
});

test("Rekor v2 hashedRekordV002 binds the same retained signature content", () => {
  const bundle = bundleFromJSON(bundleFixture);
  const signedEntity = toSignedEntity(bundle, Buffer.from(packageIndex));
  const body = {
    kind: "hashedrekord",
    apiVersion: "0.0.2",
    spec: {
      hashedRekordV002: {
        data: {
          algorithm: "SHA2_256",
          digest: bundleFixture.messageSignature.messageDigest.digest,
        },
        signature: { content: bundleFixture.messageSignature.signature },
      },
    },
  };
  expect(() =>
    verifyTLogBody(
      {
        kindVersion: { kind: "hashedrekord", version: "0.0.2" },
        canonicalizedBody: Buffer.from(JSON.stringify(body)),
      } as Parameters<typeof verifyTLogBody>[0],
      signedEntity.signature,
    ),
  ).not.toThrow();
});

test("reviewed TrustedRoot retains the Rekor v2 Ed25519 authority by declared log ID", () => {
  const root = TrustedRoot.fromJSON(trustedRootJson);
  const authority = root.tlogs.find(
    ({ publicKey }) => publicKey?.keyDetails === PublicKeyDetails.PKIX_ED25519,
  );
  expect(authority?.logId?.keyId.byteLength).toBe(32);
  const derivedSpkiDigest = createHash("sha256")
    .update(authority!.publicKey!.rawBytes)
    .digest("base64");
  expect(Buffer.from(authority!.logId!.keyId).toString("base64")).not.toBe(
    derivedSpkiDigest,
  );
});
