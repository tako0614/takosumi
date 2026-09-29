import { expect, test } from "bun:test";

import {
  connectionCredentialIssuanceAttemptRef,
  credentialIssuanceAttemptRef,
} from "../../../../core/domains/deploy-control/credential_issuance_attempt.ts";

test("credential issuance attempt is stable for one lease generation and changes on renewal or takeover", async () => {
  const initial = await credentialIssuanceAttemptRef("apply_1", "runlease_a", 0);
  expect(initial).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(
    await credentialIssuanceAttemptRef("apply_1", "runlease_a", 0),
  ).toBe(initial);
  expect(
    await credentialIssuanceAttemptRef("apply_1", "runlease_a", 1),
  ).not.toBe(initial);
  expect(
    await credentialIssuanceAttemptRef("apply_1", "runlease_b", 0),
  ).not.toBe(initial);
  expect(
    await credentialIssuanceAttemptRef("apply_2", "runlease_a", 0),
  ).not.toBe(initial);
  const connection = await connectionCredentialIssuanceAttemptRef(
    initial,
    "conn_a",
  );
  expect(
    await connectionCredentialIssuanceAttemptRef(initial, "conn_a"),
  ).toBe(connection);
  expect(
    await connectionCredentialIssuanceAttemptRef(initial, "conn_b"),
  ).not.toBe(connection);
});
