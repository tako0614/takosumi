import { stringValue } from "./http-helpers.ts";

const publicCapsuleOperationErrorMessages = new Set([
  "materialize worker failed",
  "materialize worker returned mismatched preserveDigest",
  "materialize worker did not return a dedicated runtime target",
  "materialize worker did not return continuity evidence",
  "materialize worker continuity requires cutover evidence",
  "materialize worker continuity sourceDataNamespace mismatch",
  "materialize worker continuity source runtime target mismatch",
  "materialize worker continuity dedicated runtime target mismatch",
  "materialize worker continuity requires dedicated readiness",
  "materialize worker continuity OIDC client mismatch",
  "materialize worker continuity service binding refs mismatch",
  "materialize canceled before cutover",
  "installation export bundle could not be collected",
  "export worker failed",
  "export worker did not return a downloadUrl",
  "export worker returned an unsupported downloadUrl",
  "export worker returned an invalid downloadExpiresAt",
]);

export function publicCapsuleOperationErrorMessage(
  value: unknown,
  fallback: string,
): string {
  const message = stringValue(value);
  return message && publicCapsuleOperationErrorMessages.has(message)
    ? message
    : fallback;
}
