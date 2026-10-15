/** Synthetic availability transport only. Ephemeral keys never qualify a real
 * review issuer, mint an approval, or establish a production deployment graph. */
import type { OwnerOperationTarget } from "../../../../accounts/service/src/owner-operation-contract.ts";
import { base64UrlEncodeBytes } from "../../../../accounts/service/src/encoding.ts";
import {
  createReviewedRecoveryIssuerAvailabilityReader,
  reviewedRecoveryIssuerAvailabilitySignatureInput,
  type ReviewedRecoveryIssuerAvailabilityChallenge,
  type ReviewedRecoveryIssuerAvailabilityStatus,
} from "../../../../accounts/service/src/reviewed-recovery-issuer-availability.ts";

export async function reviewIssuerAvailabilityFixture(input: {
  target: OwnerOperationTarget;
  now: () => number;
  beforeResponse?: (challenge: ReviewedRecoveryIssuerAvailabilityChallenge) => void | Promise<void>;
  status?: "available" | "unavailable";
}) {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const issuer = { issuer: "https://review-issuer.fixture.invalid", keyId: "isolated-ephemeral-review-key", publicKey: keys.publicKey };
  const challenges: ReviewedRecoveryIssuerAvailabilityChallenge[] = [];
  const reader = createReviewedRecoveryIssuerAvailabilityReader({
    target: input.target, clientId: input.target.ownerClientId, environment: "staging", reviewIssuer: issuer, now: input.now,
    async readSignedStatus(challenge) {
      challenges.push(structuredClone(challenge));
      await input.beforeResponse?.(challenge);
      const response: ReviewedRecoveryIssuerAvailabilityStatus = { version: "takosumi.accounts.review-issuer-availability@v1", status: input.status ?? "available", challenge,
        attestation: { algorithm: "ES256", issuer: issuer.issuer, keyId: issuer.keyId, signature: "" } };
      const bytes = reviewedRecoveryIssuerAvailabilitySignatureInput(response);
      const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, bytes.buffer as ArrayBuffer);
      return { ...response, attestation: { ...response.attestation, signature: base64UrlEncodeBytes(new Uint8Array(signature)) } };
    },
  });
  return { reader, challenges };
}
