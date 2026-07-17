import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  FormPackageArtifactReader,
  FormPackageVerifier,
} from "../../../core/domains/service-forms/mod.ts";
import { TakoformDataOnlyPackageVerifier } from "../../../core/adapters/takoform/package_verifier.ts";
import {
  SigstoreTakoformPackageSignatureVerifier,
  type TakoformPublisherPolicy,
} from "../../../core/adapters/takoform/signature.ts";

const MAX_PACKAGE_ENVELOPE_BYTES = 32 << 20;
const MAX_TRUSTED_ROOT_BYTES = 4 << 20;
const RELATIVE_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;

export interface NodeTakoformPackageTrustPolicy {
  readonly schemaVersion: 1;
  /** Absolute private immutable-staging directory owned by the operator. */
  readonly artifactRoot: string;
  /** Relative path under artifactRoot to Sigstore TrustedRoot JSON. */
  readonly trustedRootPath: string;
  readonly trustedRootDigest: `sha256:${string}`;
  readonly publishers: readonly TakoformPublisherPolicy[];
}

export interface NodeTakoformPackageHostComposition {
  readonly artifactReader: FormPackageArtifactReader;
  readonly verifier: FormPackageVerifier;
}

/** Bun/Node + Postgres production composition over private immutable files. */
export async function createNodeTakoformPackageHostComposition(
  policy: NodeTakoformPackageTrustPolicy,
): Promise<NodeTakoformPackageHostComposition> {
  validatePolicy(policy);
  const root = await realpath(policy.artifactRoot);
  const reader = new FileTakoformPackageArtifactReader(root);
  const signatureVerifier = new SigstoreTakoformPackageSignatureVerifier({
    trustedRootDigest: policy.trustedRootDigest,
    publishers: policy.publishers,
    loadTrustedRoot: async () =>
      await readStableFile(
        root,
        policy.trustedRootPath,
        MAX_TRUSTED_ROOT_BYTES,
        "Sigstore TrustedRoot",
      ),
  });
  return {
    artifactReader: reader,
    verifier: new TakoformDataOnlyPackageVerifier(signatureVerifier),
  };
}

export class FileTakoformPackageArtifactReader implements FormPackageArtifactReader {
  constructor(private readonly root: string) {
    if (!isAbsolute(root))
      throw new TypeError("artifact root must be absolute");
  }

  async read(artifactRef: string): Promise<Uint8Array> {
    if (!artifactRef.startsWith("file:")) {
      throw new TypeError(
        "Node Form Package artifactRef must use file:<relative-path>",
      );
    }
    return await readStableFile(
      this.root,
      artifactRef.slice(5),
      MAX_PACKAGE_ENVELOPE_BYTES,
      "Form Package install envelope",
    );
  }
}

async function readStableFile(
  root: string,
  relativePath: string,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  validateRelativePath(relativePath, label);
  const candidate = resolve(root, relativePath);
  const canonical = await realpath(candidate);
  if (canonical !== candidate) {
    throw new TypeError(`${label} must not traverse a symbolic link`);
  }
  const fromRoot = relative(root, canonical);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new TypeError(`${label} is outside the private artifact root`);
  }
  const handle = await open(
    canonical,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) {
      throw new TypeError(
        `${label} must be a regular file of at most ${maxBytes} bytes`,
      );
    }
    const body = await handle.readFile();
    const after = await handle.stat();
    if (
      body.byteLength !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new TypeError(`${label} changed while it was read`);
    }
    return new Uint8Array(body);
  } finally {
    await handle.close();
  }
}

function validatePolicy(policy: NodeTakoformPackageTrustPolicy): void {
  if (policy.schemaVersion !== 1 || !isAbsolute(policy.artifactRoot)) {
    throw new TypeError(
      "Node Form Package trust policy requires schemaVersion 1 and an absolute artifactRoot",
    );
  }
  validateRelativePath(policy.trustedRootPath, "trustedRootPath");
  if (!/^sha256:[0-9a-f]{64}$/u.test(policy.trustedRootDigest)) {
    throw new TypeError("trustedRootDigest must be an exact sha256 digest");
  }
  if (policy.publishers.length === 0) {
    throw new TypeError("at least one trusted publisher is required");
  }
}

function validateRelativePath(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    !RELATIVE_PATH_RE.test(value) ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError(`${label} must be a canonical relative path`);
  }
}
