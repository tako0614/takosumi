import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import * as rootRuntime from "../../contract/runtime.ts";
import { TAKOSUMI_BACKGROUND_EVENT_INVOKE_PATH } from "../../contract/background-events.ts";
import {
  TAKOSUMI_MANAGED_RUNTIME_GATEWAY_BINDING,
  TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION_BINDING,
} from "../../contract/managed-runtime-connections.ts";

const packageJson = JSON.parse(
  await readFile(
    new URL("../../contract/package.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
  readonly private?: boolean;
  readonly files?: readonly string[];
  readonly exports?: Readonly<Record<string, string>>;
  readonly publishConfig?: { readonly access?: string };
};

test("the OSS contract directory is an explicit public package", () => {
  expect(packageJson).toMatchObject({
    name: "@takosjp/takosumi-contract",
    version: "2.1.0",
    license: "MIT",
    publishConfig: { access: "public" },
  });
  expect(packageJson.private).not.toBe(true);
  expect(packageJson.files).toEqual([
    "runtime.ts",
    "cron.ts",
    "background-events.ts",
    "managed-runtime-connections.ts",
    "managed-relational-runtime.ts",
    "discovery.ts",
    "api-surface.ts",
    "capabilities.ts",
    "interface-types.ts",
    "runtime-interfaces.ts",
    "notification-pushers.ts",
    "identity-oidc.ts",
    "types.ts",
    "LICENSE",
    "README.md",
  ]);
  expect(packageJson.exports).toEqual({
    ".": "./runtime.ts",
    "./background-events": "./background-events.ts",
    "./managed-runtime-connections": "./managed-runtime-connections.ts",
    "./managed-relational-runtime": "./managed-relational-runtime.ts",
    "./discovery": "./discovery.ts",
    "./interface-types": "./interface-types.ts",
    "./runtime-interfaces": "./runtime-interfaces.ts",
    "./notification-pushers": "./notification-pushers.ts",
    "./identity-oidc": "./identity-oidc.ts",
  });
});

test("root and explicit runtime subpaths expose one contract identity", () => {
  expect(rootRuntime.TAKOSUMI_BACKGROUND_EVENT_ABI).toBe(
    "takosumi.background-event/v2",
  );
  expect(TAKOSUMI_BACKGROUND_EVENT_INVOKE_PATH).toBe(
    "/.well-known/takosumi/background-events/v2/invoke",
  );
  expect(rootRuntime.TAKOSUMI_MANAGED_RUNTIME_CONNECTION_CONTRACT).toBe(
    "takosumi.managed-runtime-connection/v1",
  );
  expect(TAKOSUMI_MANAGED_RUNTIME_GATEWAY_BINDING).toBe(
    "TAKOSUMI_MANAGED_RUNTIME",
  );
  expect(TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION_BINDING).toBe(
    "TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION",
  );
});

test("the 2.1 root keeps the exact 2.0 runtime value exports", () => {
  expect(Object.keys(rootRuntime).sort()).toEqual([
    "MANAGED_RELATIONAL_LIMITS",
    "ManagedRelationalRuntimeContractError",
    "ManagedRuntimeConnectionContractError",
    "TAKOSUMI_BACKGROUND_EVENT_ABI",
    "TAKOSUMI_BACKGROUND_EVENT_AUTHORITY_PROP",
    "TAKOSUMI_BACKGROUND_EVENT_AUTHORITY_VERSION",
    "TAKOSUMI_BACKGROUND_EVENT_INVOKE_PATH",
    "TAKOSUMI_BACKGROUND_EVENT_RESULT_VERSION",
    "TAKOSUMI_MANAGED_RELATIONAL_RUNTIME_CONTRACT",
    "TAKOSUMI_MANAGED_RELATIONAL_RUNTIME_PATH",
    "TAKOSUMI_MANAGED_RUNTIME_CAPABILITY_REF_HEADER",
    "TAKOSUMI_MANAGED_RUNTIME_CONNECTION_CONTRACT",
    "TAKOSUMI_MANAGED_RUNTIME_GATEWAY_BINDING",
    "TAKOSUMI_MANAGED_RUNTIME_INVOKE_PERMISSION",
    "TAKOSUMI_MANAGED_RUNTIME_KV_EXPIRATION_HEADER",
    "TAKOSUMI_MANAGED_RUNTIME_KV_EXPIRATION_TTL_HEADER",
    "TAKOSUMI_MANAGED_RUNTIME_KV_METADATA_HEADER",
    "TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION_BINDING",
    "TAKOSUMI_MANAGED_RUNTIME_OBJECT_METADATA_HEADER",
    "assertManagedRuntimeRequirementsSupported",
    "managedRelationalBatchGatewayRequest",
    "managedRelationalConnection",
    "managedRuntimeConnection",
    "managedRuntimeGatewayFailure",
    "managedRuntimeGatewayRequest",
    "managedRuntimeKeyValueListRequest",
    "managedRuntimeKeyValueRequest",
    "managedRuntimeObjectListRequest",
    "managedRuntimeObjectRequest",
    "managedRuntimeQueueBatchSendGatewayRequest",
    "managedRuntimeQueueSendGatewayRequest",
    "managedRuntimeResourceUrl",
    "matchesPortableCron",
    "nextPortableCronOccurrence",
    "normalizePortableCron",
    "parseManagedRelationalBatchRequest",
    "parseManagedRelationalBatchResponse",
    "parseManagedRuntimeConnectionMaterialization",
    "parseManagedRuntimeKeyValueListResponse",
    "parseManagedRuntimeObjectListResponse",
    "parseManagedRuntimeQueueAckRequest",
    "parseManagedRuntimeQueueBatchSendRequest",
    "parseManagedRuntimeQueuePullRequest",
    "parseManagedRuntimeQueuePullResponse",
    "parseManagedRuntimeQueueSendRequest",
    "parseManagedRuntimeQueueSendResponse",
    "parseTakosumiBackgroundEventAck",
    "parseTakosumiBackgroundEventAuthority",
    "parseTakosumiBackgroundEventEnvelope",
    "takosumiBackgroundEventEnvelopeDigest",
  ]);
});
