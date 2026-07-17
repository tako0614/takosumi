import {
  assertBundleLatest,
  bundleFromJSON,
  isBundleWithCertificateChain,
  isBundleWithMessageSignature,
} from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import { Buffer } from "node:buffer";
import { sha256HexAsync } from "../../shared/runtime/hash.ts";
import { parseCanonicalJson } from "./canonical_json.ts";

export interface TakoformPublisherPolicy {
  readonly oidcIssuer: string;
  readonly sourceRepository: string;
  readonly workflow: string;
  /** Git ref glob. `*` matches exactly one non-slash path segment. */
  readonly tagPattern: string;
}

export interface TakoformSigstoreTrustPolicy {
  readonly trustedRootDigest: `sha256:${string}`;
  readonly loadTrustedRoot: () => Promise<Uint8Array>;
  readonly publishers: readonly TakoformPublisherPolicy[];
}

export interface VerifiedTakoformPublisher {
  readonly oidcIssuer: string;
  readonly certificateIdentity: string;
  readonly sourceRepository: string;
  readonly workflow: string;
  readonly ref: string;
}

/** Host trust contribution used by the format verifier. */
export interface TakoformPackageSignatureVerifier {
  readonly id: string;
  verify(
    canonicalPackageIndex: Uint8Array,
    signatureBundle: unknown,
  ): Promise<VerifiedTakoformPublisher>;
}

/**
 * Offline Sigstore verifier for the keyless Takoform Form Package trust lane.
 * The distribution endpoint is not trusted: certificate, CT, Rekor inclusion,
 * publisher identity, bundle signature, and a digest-pinned TrustedRoot are all
 * checked from retained input bytes.
 */
export class SigstoreTakoformPackageSignatureVerifier implements TakoformPackageSignatureVerifier {
  readonly id = "takoform.sigstore-keyless.v1";
  readonly #policy: TakoformSigstoreTrustPolicy;
  #trustMaterial?: ReturnType<typeof toTrustMaterial>;

  constructor(policy: TakoformSigstoreTrustPolicy) {
    if (policy.publishers.length === 0) {
      throw new TypeError(
        "at least one trusted Takoform publisher is required",
      );
    }
    for (const publisher of policy.publishers) validatePublisher(publisher);
    if (!/^sha256:[0-9a-f]{64}$/u.test(policy.trustedRootDigest)) {
      throw new TypeError("trustedRootDigest must be an exact sha256 digest");
    }
    this.#policy = policy;
  }

  async verify(
    canonicalPackageIndex: Uint8Array,
    signatureBundle: unknown,
  ): Promise<VerifiedTakoformPublisher> {
    let bundle;
    try {
      bundle = bundleFromJSON(signatureBundle);
      assertBundleLatest(bundle);
    } catch (error) {
      throw new TypeError("invalid Sigstore v0.3 bundle", { cause: error });
    }
    if (!isBundleWithMessageSignature(bundle)) {
      throw new TypeError(
        "Takoform package bundle must sign the canonical index blob",
      );
    }
    if (!isBundleWithCertificateChain(bundle)) {
      throw new TypeError(
        "Takoform package bundle must use keyless X.509 identity",
      );
    }
    if (
      bundle.verificationMaterial.tlogEntries.length === 0 ||
      bundle.verificationMaterial.tlogEntries.some(
        (entry) => entry.inclusionProof === undefined,
      )
    ) {
      throw new TypeError(
        "Sigstore bundle has no offline Rekor inclusion proof",
      );
    }

    const verifier = new Verifier(await this.#trustedMaterial(), {
      tlogThreshold: 1,
      ctlogThreshold: 1,
      timestampThreshold: 0,
    });
    let signer;
    try {
      signer = verifier.verify(
        toSignedEntity(bundle, Buffer.from(canonicalPackageIndex)),
      );
    } catch (error) {
      throw new TypeError(
        "Sigstore signature or transparency verification failed",
        {
          cause: error,
        },
      );
    }
    const issuer = signer.identity?.extensions?.issuer;
    const identity = signer.identity?.subjectAlternativeName;
    if (!issuer || !identity) {
      throw new TypeError(
        "Sigstore signer has no Fulcio issuer or certificate identity",
      );
    }
    const matched = this.#policy.publishers
      .map((publisher) => matchPublisher(publisher, issuer, identity))
      .find((result) => result !== undefined);
    if (!matched) {
      throw new TypeError(
        "Sigstore signer is outside the host publisher policy",
      );
    }
    return matched;
  }

  async #trustedMaterial(): Promise<ReturnType<typeof toTrustMaterial>> {
    if (this.#trustMaterial) return this.#trustMaterial;
    const bytes = await this.#policy.loadTrustedRoot();
    const digest = `sha256:${await sha256HexAsync(bytes)}`;
    if (digest !== this.#policy.trustedRootDigest) {
      throw new TypeError(
        `Sigstore TrustedRoot digest mismatch: expected ${this.#policy.trustedRootDigest}, got ${digest}`,
      );
    }
    let trustedRoot;
    try {
      trustedRoot = TrustedRoot.fromJSON(parseCanonicalJson(bytes));
    } catch (error) {
      throw new TypeError("invalid Sigstore TrustedRoot JSON", {
        cause: error,
      });
    }
    this.#trustMaterial = toTrustMaterial(trustedRoot);
    return this.#trustMaterial;
  }
}

function validatePublisher(publisher: TakoformPublisherPolicy): void {
  const issuer = new URL(publisher.oidcIssuer);
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.origin !== publisher.oidcIssuer
  ) {
    throw new TypeError("publisher oidcIssuer must be an HTTPS origin");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(publisher.sourceRepository)) {
    throw new TypeError("publisher sourceRepository must be owner/repository");
  }
  if (
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(publisher.workflow)
  ) {
    throw new TypeError(
      "publisher workflow must be a protected GitHub workflow path",
    );
  }
  if (
    !publisher.tagPattern.startsWith("refs/tags/") ||
    publisher.tagPattern.includes("**")
  ) {
    throw new TypeError(
      "publisher tagPattern must be a single-segment Git tag glob",
    );
  }
  globToRegExp(publisher.tagPattern);
}

function matchPublisher(
  publisher: TakoformPublisherPolicy,
  issuer: string,
  certificateIdentity: string,
): VerifiedTakoformPublisher | undefined {
  if (publisher.oidcIssuer !== issuer) return undefined;
  const marker = "@";
  const split = certificateIdentity.lastIndexOf(marker);
  if (split < 1) return undefined;
  const workflowIdentity = certificateIdentity.slice(0, split);
  const ref = certificateIdentity.slice(split + 1);
  const expectedWorkflowIdentity = `https://github.com/${publisher.sourceRepository}/${publisher.workflow}`;
  if (
    workflowIdentity !== expectedWorkflowIdentity ||
    !globToRegExp(publisher.tagPattern).test(ref)
  ) {
    return undefined;
  }
  return {
    oidcIssuer: issuer,
    certificateIdentity,
    sourceRepository: publisher.sourceRepository,
    workflow: publisher.workflow,
    ref,
  };
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("[^/]+?");
  return new RegExp(`^${escaped}$`, "u");
}
