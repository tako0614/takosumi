import { expect, test } from "bun:test";
import { ConnectionVaultError } from "../../../../core/adapters/vault/mod.ts";
import {
  mapVaultError,
  OpenTofuControllerError,
  runErrorCode,
  SOURCE_SYNC_REQUIRED_REASON,
  sourceSyncRequiredError,
  structuredErrorReason,
} from "../../../../core/domains/deploy-control/errors.ts";

test("sourceSyncRequiredError carries a stable structured reason", () => {
  const error = sourceSyncRequiredError(
    "Source src_1 does not have an immutable snapshot yet",
  );

  expect(error).toMatchObject({
    code: "failed_precondition",
    message: "Source src_1 does not have an immutable snapshot yet",
    details: { reason: SOURCE_SYNC_REQUIRED_REASON },
  });
});

test("Vault semantic reasons survive the controller boundary", () => {
  const mapped = mapVaultError(
    new ConnectionVaultError(
      "failed_precondition",
      "connection verification is pending",
      undefined,
      "provider_connection_not_ready",
    ),
  );

  expect(mapped).toBeInstanceOf(OpenTofuControllerError);
  expect(structuredErrorReason(mapped)).toBe("provider_connection_not_ready");
});

test("Run classification reads details.reason and never parses Error.message", () => {
  const structured = new OpenTofuControllerError(
    "failed_precondition",
    "human wording can change freely",
    { reason: "provider_connection_changed" },
  );
  expect(structuredErrorReason(structured)).toBe("provider_connection_changed");
  expect(runErrorCode(structured, "apply_failed")).toBe(
    "provider_connection_changed",
  );

  const proseOnly = new Error(
    "provider_connection_changed: this looks like a code but is only prose",
  );
  expect(structuredErrorReason(proseOnly)).toBeUndefined();
  expect(runErrorCode(proseOnly, "apply_failed")).toBe("apply_failed");
});
