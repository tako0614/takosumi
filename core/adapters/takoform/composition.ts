import type {
  FormPackageArtifactReader,
  FormPackageVerifier,
} from "../../domains/service-forms/mod.ts";
import { parseCanonicalJson } from "./canonical_json.ts";
import { TakoformDataOnlyPackageVerifier } from "./package_verifier.ts";
import {
  SigstoreTakoformPackageSignatureVerifier,
  type TakoformPublisherPolicy,
} from "./signature.ts";

const MAX_PACKAGE_ENVELOPE_BYTES = 32 << 20;
const MAX_TRUSTED_ROOT_BYTES = 4 << 20;

export interface TakoformArtifactObject {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface TakoformArtifactBucket {
  get(key: string): Promise<TakoformArtifactObject | null>;
}

export interface TakoformPackageHostTrustPolicyDocument {
  readonly schemaVersion: 1;
  /** R2 key prefix reserved for immutable package install envelopes. */
  readonly artifactPrefix: string;
  readonly trustedRoot: {
    /** R2 key containing the offline Sigstore TrustedRoot JSON. */
    readonly key: string;
    readonly digest: `sha256:${string}`;
  };
  readonly publishers: readonly TakoformPublisherPolicy[];
}

export interface TakoformPackageHostComposition {
  readonly artifactReader: FormPackageArtifactReader;
  readonly verifier: FormPackageVerifier;
}

/**
 * Production-capable D1/Workers composition. Both packages and the digest-
 * pinned Sigstore TrustedRoot are read from an operator-owned R2 bucket. A
 * customer Resource request can never select or fetch an artifact.
 */
export function createR2TakoformPackageHostComposition(input: {
  readonly bucket: TakoformArtifactBucket;
  readonly trustPolicy: TakoformPackageHostTrustPolicyDocument | string;
}): TakoformPackageHostComposition {
  const policy = parseTrustPolicy(input.trustPolicy);
  const artifactReader = new R2TakoformPackageArtifactReader(
    input.bucket,
    policy.artifactPrefix,
  );
  const signatureVerifier = new SigstoreTakoformPackageSignatureVerifier({
    trustedRootDigest: policy.trustedRoot.digest,
    publishers: policy.publishers,
    loadTrustedRoot: async () =>
      await readR2Object(
        input.bucket,
        policy.trustedRoot.key,
        MAX_TRUSTED_ROOT_BYTES,
        "Sigstore TrustedRoot",
      ),
  });
  return {
    artifactReader,
    verifier: new TakoformDataOnlyPackageVerifier(signatureVerifier),
  };
}

export class R2TakoformPackageArtifactReader implements FormPackageArtifactReader {
  readonly #prefix: string;

  constructor(
    private readonly bucket: TakoformArtifactBucket,
    prefix: string,
  ) {
    this.#prefix = validateR2Key(prefix, "artifactPrefix", true);
    if (!this.#prefix.endsWith("/")) {
      throw new TypeError("artifactPrefix must end with '/'");
    }
  }

  async read(artifactRef: string): Promise<Uint8Array> {
    if (!artifactRef.startsWith("r2:")) {
      throw new TypeError(
        "Takoform package artifactRef must use the r2: scheme",
      );
    }
    const key = validateR2Key(artifactRef.slice(3), "artifactRef", false);
    if (!key.startsWith(this.#prefix) || key === this.#prefix) {
      throw new TypeError(
        "Takoform package artifactRef is outside the trusted R2 prefix",
      );
    }
    return await readR2Object(
      this.bucket,
      key,
      MAX_PACKAGE_ENVELOPE_BYTES,
      "Form Package install envelope",
    );
  }
}

export function parseTrustPolicy(
  input: TakoformPackageHostTrustPolicyDocument | string,
): TakoformPackageHostTrustPolicyDocument {
  const value =
    typeof input === "string"
      ? parseCanonicalJson(new TextEncoder().encode(input))
      : input;
  if (!isRecord(value))
    throw new TypeError("Form Package trust policy must be an object");
  assertExactKeys(
    value,
    ["schemaVersion", "artifactPrefix", "trustedRoot", "publishers"],
    "Form Package trust policy",
  );
  if (value.schemaVersion !== 1) {
    throw new TypeError("unsupported Form Package trust policy version");
  }
  const artifactPrefix = validateR2Key(
    value.artifactPrefix,
    "artifactPrefix",
    true,
  );
  if (!artifactPrefix.endsWith("/"))
    throw new TypeError("artifactPrefix must end with '/'");
  if (!isRecord(value.trustedRoot))
    throw new TypeError("trustedRoot must be an object");
  assertExactKeys(value.trustedRoot, ["key", "digest"], "trustedRoot");
  const trustedRootKey = validateR2Key(
    value.trustedRoot.key,
    "trustedRoot.key",
    false,
  );
  const trustedRootDigest = value.trustedRoot.digest;
  if (
    typeof trustedRootDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(trustedRootDigest)
  ) {
    throw new TypeError("trustedRoot.digest must be an exact sha256 digest");
  }
  if (
    !Array.isArray(value.publishers) ||
    value.publishers.length === 0 ||
    value.publishers.length > 32
  ) {
    throw new TypeError("publishers must be a non-empty bounded array");
  }
  const publishers = value.publishers.map((entry, position) => {
    if (!isRecord(entry))
      throw new TypeError(`publishers[${position}] must be an object`);
    assertExactKeys(
      entry,
      ["oidcIssuer", "sourceRepository", "workflow", "tagPattern"],
      `publishers[${position}]`,
    );
    for (const key of [
      "oidcIssuer",
      "sourceRepository",
      "workflow",
      "tagPattern",
    ] as const) {
      if (typeof entry[key] !== "string" || entry[key].length === 0) {
        throw new TypeError(`publishers[${position}].${key} must be a string`);
      }
    }
    return {
      oidcIssuer: entry.oidcIssuer as string,
      sourceRepository: entry.sourceRepository as string,
      workflow: entry.workflow as string,
      tagPattern: entry.tagPattern as string,
    };
  });
  return {
    schemaVersion: 1,
    artifactPrefix,
    trustedRoot: {
      key: trustedRootKey,
      digest: trustedRootDigest as `sha256:${string}`,
    },
    publishers,
  };
}

async function readR2Object(
  bucket: TakoformArtifactBucket,
  key: string,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const object = await bucket.get(key);
  if (!object) throw new TypeError(`${label} ${key} was not found`);
  if (
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    object.size > maxBytes
  ) {
    throw new TypeError(`${label} ${key} exceeds ${maxBytes} bytes`);
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== object.size) {
    throw new TypeError(`${label} ${key} changed while it was read`);
  }
  return bytes;
}

function validateR2Key(
  value: unknown,
  label: string,
  allowTrailingSlash: boolean,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    (!allowTrailingSlash && value.endsWith("/"))
  ) {
    throw new TypeError(`${label} must be a canonical R2 object key`);
  }
  const pathForSegments =
    allowTrailingSlash && value.endsWith("/") ? value.slice(0, -1) : value;
  if (
    pathForSegments
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError(`${label} must be a canonical R2 object key`);
  }
  return value;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((entry, index) => entry !== wanted[index])
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
