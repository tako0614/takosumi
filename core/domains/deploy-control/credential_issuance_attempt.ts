import { stableJsonDigest } from "../../adapters/source/digest.ts";

/**
 * Value-free identity for one credential mint under the winning Run lease.
 * The lease is a fence, not extension authority: only its digest crosses the
 * trusted driver boundary. A new claim lease or refresh ordinal is a new mint;
 * an exact transport retry within that mint keeps the same reference.
 */
export async function credentialIssuanceAttemptRef(
  runningRunId: string,
  leaseToken: string,
  ordinal: number,
): Promise<`sha256:${string}`> {
  if (
    !runningRunId || !leaseToken || !Number.isSafeInteger(ordinal) ||
    ordinal < 0
  ) {
    throw new TypeError("credential issuance attempt identity is invalid");
  }
  return await stableJsonDigest({
    kind: "takosumi.run-credential-issuance-attempt@v1",
    runningRunId,
    leaseToken,
    ordinal,
  }) as `sha256:${string}`;
}

/** Bind the mint generation to the exact resolved Provider Connection. */
export async function connectionCredentialIssuanceAttemptRef(
  generationRef: `sha256:${string}`,
  connectionId: string,
): Promise<`sha256:${string}`> {
  if (!/^sha256:[0-9a-f]{64}$/u.test(generationRef) || !connectionId) {
    throw new TypeError("credential issuance connection identity is invalid");
  }
  return await stableJsonDigest({
    kind: "takosumi.provider-credential-issuance-attempt@v1",
    generationRef,
    connectionId,
  }) as `sha256:${string}`;
}
