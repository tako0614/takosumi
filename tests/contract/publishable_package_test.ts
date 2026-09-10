import { expect, test } from "bun:test";

import { contractPackageFiles } from "../../scripts/check-contract-package-files.ts";
import { readFile } from "node:fs/promises";

import * as rootRuntime from "../../contract/runtime.ts";
import { TAKOSUMI_BACKGROUND_EVENT_INVOKE_PATH } from "../../contract/background-events.ts";
import {
  TAKOSUMI_MANAGED_RUNTIME_GATEWAY_BINDING,
  TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION_BINDING,
} from "../../contract/managed-runtime-connections.ts";

const PACK_TIMEOUT_MS = 15_000;

async function packedFiles(): Promise<readonly string[]> {
  const detached = process.platform !== "win32";
  const child = Bun.spawn(
    ["npm", "pack", "--dry-run", "--ignore-scripts", "--json"],
    {
      cwd: new URL("../../contract", import.meta.url).pathname,
      // POSIX process groups let this read-only probe reap npm descendants;
      // Bun's Windows fallback can only kill the direct child.
      detached,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let timedOut = false;
  let succeeded = false;
  const killPack = (markTimedOut: boolean): void => {
    if (markTimedOut) timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // The child may have exited between the deadline and this cleanup.
    }
    if (detached) {
      try {
        // `detached` gives the npm process its own POSIX process group. Kill
        // that group so descendants cannot keep the captured pipes open.
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group may already have exited; the direct child is still reaped.
      }
    }
  };
  const timeout = setTimeout(() => killPack(true), PACK_TIMEOUT_MS);
  try {
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    const exitCode = await child.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    const signalCode =
      "signalCode" in child
        ? String((child as { readonly signalCode?: unknown }).signalCode ?? "none")
        : "none";
    if (timedOut) {
      throw new Error(
        `npm pack timed out after ${PACK_TIMEOUT_MS}ms (exit=${exitCode}, signal=${signalCode}, stdoutBytes=${stdout.length}): ${stderr.slice(0, 2000) || "no stderr"}`,
      );
    }
    if (exitCode !== 0) {
      throw new Error(
        `npm pack failed (exit=${exitCode}, signal=${signalCode}, stdoutBytes=${stdout.length}): ${stderr.slice(0, 2000) || "no stderr"}`,
      );
    }
    if (stdout.trim().length === 0) {
      throw new Error(
        `npm pack returned empty stdout (stdoutBytes=${stdout.length}): ${stderr.slice(0, 2000) || "no stderr"}`,
      );
    }
    let report: unknown;
    try {
      report = JSON.parse(stdout);
    } catch {
      throw new Error(
        `npm pack returned invalid JSON (stdoutBytes=${stdout.length}): ${stderr.slice(0, 2000) || "no stderr"}`,
      );
    }
    const files =
      Array.isArray(report) &&
      report.length === 1 &&
      report[0] &&
      typeof report[0] === "object"
        ? (report[0] as { readonly files?: unknown }).files
        : undefined;
    if (
      !Array.isArray(files) ||
      files.length === 0 ||
      files.some(
        (file) =>
          !file ||
          typeof file !== "object" ||
          typeof (file as { readonly path?: unknown }).path !== "string",
      )
    ) {
      throw new Error(
        `npm pack returned an unexpected report (stdoutBytes=${stdout.length}): ${stderr.slice(0, 2000) || "no stderr"}`,
      );
    }
    succeeded = true;
    return files.map((file) => (file as { readonly path: string }).path);
  } finally {
    clearTimeout(timeout);
    if (!succeeded) {
      killPack(false);
      await child.exited.catch(() => undefined);
    }
  }
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

// Run the real pack once during module setup. Keeping this subprocess outside
// an individual test's 5-second budget makes the package assertion stable when
// Bun runs it alongside the full parallel suite.
const packedArchiveFiles = new Set(await packedFiles());

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
  for (const [subpath, target] of exported) {
    expect(target.startsWith("./")).toBe(true);
    // The relation, not a list: a subpath whose target is not in the packed
    // tarball is exactly the shape of a broken published export.
    expect({ subpath, packed: packedArchiveFiles.has(target.slice(2)) }).toEqual({
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
