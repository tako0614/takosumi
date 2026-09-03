import { expect, test } from "bun:test";

import { contractPackageFiles } from "../../scripts/check-contract-package-files.ts";
import { readFile } from "node:fs/promises";

import * as rootRuntime from "../../contract/runtime.ts";
import { TAKOSUMI_BACKGROUND_EVENT_INVOKE_PATH } from "../../contract/background-events.ts";
import {
  TAKOSUMI_MANAGED_RUNTIME_GATEWAY_BINDING,
  TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION_BINDING,
} from "../../contract/managed-runtime-connections.ts";

async function packedFiles(): Promise<readonly string[]> {
  const packed = Bun.spawnSync(
    ["npm", "pack", "--dry-run", "--ignore-scripts", "--json"],
    {
      cwd: new URL("../../contract", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const report = JSON.parse(packed.stdout.toString()) as readonly {
    readonly files: readonly { readonly path: string }[];
  }[];
  return report[0]!.files.map((file) => file.path);
}

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
  // `files` is DERIVED from `exports` — every export target plus everything it
  // transitively imports — not hand-listed. The hand-listed array named 13 of
  // 57 modules, so every wire type a consumer tracks (runs, capsules,
  // workspaces, the deploy-control API) was importable in this repository and
  // absent from the published bytes. The package stays curated: what is curated
  // is `exports`, and `files` follows from it.
  expect(packageJson.files).toEqual([...contractPackageFiles(packageJson)]);
});

test("every export subpath resolves to a module the package actually ships", async () => {
  const exported = Object.entries(packageJson.exports ?? {});
  expect(exported.length).toBeGreaterThan(0);
  const packed = new Set(await packedFiles());
  for (const [subpath, target] of exported) {
    expect(target.startsWith("./")).toBe(true);
    // The relation, not a list: a subpath whose target is not in the packed
    // tarball is exactly the shape of a broken published export.
    expect({ subpath, packed: packed.has(target.slice(2)) }).toEqual({
      subpath,
      packed: true,
    });
    await import(new URL(`../../contract/${target.slice(2)}`, import.meta.url).pathname);
  }
});

test("the wire modules a consumer tracks are importable subpaths", () => {
  // These are what an external consumer pins against: they were reachable in
  // this repository and unreachable from the published package.
  for (const subpath of [
    "./deploy-control-api",
    "./runs",
    "./capsules",
    "./workspaces",
  ]) {
    expect(Object.keys(packageJson.exports ?? {})).toContain(subpath);
  }
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
