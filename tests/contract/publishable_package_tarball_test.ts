import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const CONTRACT = join(ROOT, "contract");
const TSC = join(ROOT, "node_modules/.bin/tsc");
const TARBALL_NAME = "takosjp-takosumi-contract-2.1.0.tgz";

/**
 * Derived, not listed. `files` is itself derived from `exports` by
 * `scripts/check-contract-package-files.ts`, so what this test compares the
 * tarball against is the manifest the package publishes — a relation that stays
 * true across the next legitimate export, rather than a value someone has to
 * remember to edit alongside it.
 */
const EXPECTED_PACKAGE_FILES: readonly string[] = [
  ...(
    JSON.parse(
      readFileSync(join(CONTRACT, "package.json"), "utf8"),
    ) as { readonly files: readonly string[] }
  ).files,
  "package.json",
].sort();

const LEGACY_ROOT_EXPORTS = [
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
] as const;

test(
  "packed contract has an exact curated shape and compiles without sibling sources",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "takosumi-contract-2.1-"));
    try {
      const dryRun = await runChecked(
        ["bun", "pm", "pack", "--dry-run", "--ignore-scripts"],
        CONTRACT,
      );
      expect(parseDryRunFiles(dryRun.stdout)).toEqual([
        ...EXPECTED_PACKAGE_FILES,
      ]);
      // Every export subpath's target is in the packed bytes. This is the
      // defect the derivation closes: `files` named 13 of 57 modules while the
      // repository imported runs / capsules / workspaces / the deploy-control
      // API from `contract/` directly, so every wire type an external consumer
      // tracks was importable here and absent from the published package.
      const exported = (
        JSON.parse(readFileSync(join(CONTRACT, "package.json"), "utf8")) as {
          readonly exports: Readonly<Record<string, string>>;
        }
      ).exports;
      for (const target of Object.values(exported)) {
        expect(EXPECTED_PACKAGE_FILES).toContain(target.slice(2));
      }

      await runChecked(
        ["bun", "pm", "pack", "--destination", directory, "--ignore-scripts"],
        CONTRACT,
      );
      const tarball = join(directory, TARBALL_NAME);
      const tarList = await runChecked(["tar", "-tzf", tarball], directory);
      const packedPaths = tarList.stdout.trim().split("\n").sort();
      expect(packedPaths).toEqual(
        EXPECTED_PACKAGE_FILES.map((path) => `package/${path}`).sort(),
      );
      for (const path of packedPaths) {
        expect(path).not.toMatch(
          /(?:^|\/)(?:accounts|core|deploy|lib|providers|reference)(?:\/|$)/u,
        );
        expect(path).not.toMatch(
          /(?:index|interface-display|internal-api|internal-crypto)\.ts$/u,
        );
      }

      const runtimeInterfaceClosure = await readTarFiles(tarball, [
        "runtime-interfaces.ts",
        "capabilities.ts",
        "types.ts",
      ]);
      for (const forbidden of [
        "CapsuleInterfaceBlueprint",
        "CreateInterfaceRequest",
        "InterfaceCapsuleOutputInput",
        "InterfaceInputProvenance",
        "InterfaceProjectionSink",
        "capsule_blueprint",
        "capsule_required_interface",
        "materializedFrom",
        "stateVersionId",
      ]) {
        expect(runtimeInterfaceClosure).not.toContain(forbidden);
      }

      const fixture = join(directory, "consumer");
      await mkdir(fixture);
      await writeConsumerFixture(fixture, tarball);
      await runChecked(["bun", "install", "--ignore-scripts"], fixture);
      await runChecked([TSC, "--project", "tsconfig.json"], fixture);

      const legacy = await runChecked(
        ["bun", "legacy-root-consumer.ts"],
        fixture,
      );
      expect(JSON.parse(legacy.stdout)).toEqual({
        abi: "takosumi.background-event/v2",
        rootKeys: [...LEGACY_ROOT_EXPORTS],
      });

      const modern = await runChecked(["bun", "new-consumer.ts"], fixture);
      expect(JSON.parse(modern.stdout)).toEqual({
        apiVersion: "takosumi.dev/v1alpha1",
        apiBaseUrl: "https://host.example/api/v1",
        interfaceNameValid: true,
        notificationGateway: "https://push.example/",
        oidcUserinfo: "/oauth/userinfo",
        uiInterfaceType: "interface.ui.surface",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

async function writeConsumerFixture(
  fixture: string,
  tarball: string,
): Promise<void> {
  await writeFile(
    join(fixture, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          "@takosjp/takosumi-contract": `file:${tarball}`,
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(fixture, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          allowImportingTsExtensions: true,
          lib: ["ESNext", "DOM"],
          module: "Preserve",
          moduleResolution: "Bundler",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ESNext",
          types: [],
          verbatimModuleSyntax: true,
        },
        include: ["*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(fixture, "legacy-root-consumer.ts"),
    `import * as root from "@takosjp/takosumi-contract";

console.log(JSON.stringify({
  abi: root.TAKOSUMI_BACKGROUND_EVENT_ABI,
  rootKeys: Object.keys(root).sort(),
}));
`,
  );
  await writeFile(
    join(fixture, "new-consumer.ts"),
    `import {
  TAKOSUMI_API_VERSION,
  createTakosumiWellKnownDocument,
} from "@takosjp/takosumi-contract/discovery";
import { TAKOSUMI_ACCOUNTS_USERINFO_PATH } from "@takosjp/takosumi-contract/identity-oidc";
import { UI_SURFACE_INTERFACE_TYPE } from "@takosjp/takosumi-contract/interface-types";
import { normalizeNotificationPusherGatewayUrl } from "@takosjp/takosumi-contract/notification-pushers";
import {
  isValidInterfaceName,
  type Interface,
  type InterfaceBinding,
} from "@takosjp/takosumi-contract/runtime-interfaces";

const iface = {
  apiVersion: TAKOSUMI_API_VERSION,
  kind: "Interface",
  metadata: {
    id: "ifc_fixture",
    workspaceId: "ws_fixture",
    name: "app.runtime",
    ownerRef: { kind: "Capsule", id: "cap_fixture" },
    generation: 1,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  },
  spec: {
    type: "app.runtime",
    version: "1",
    document: { endpoint: "https://app.example" },
    access: { visibility: "workspace" },
  },
  status: {
    phase: "Resolved",
    observedGeneration: 1,
    resolvedRevision: 1,
  },
} satisfies Interface;

const binding = {
  apiVersion: TAKOSUMI_API_VERSION,
  kind: "InterfaceBinding",
  metadata: {
    id: "ifb_fixture",
    workspaceId: "ws_fixture",
    generation: 1,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  },
  spec: {
    interfaceId: iface.metadata.id,
    subjectRef: { kind: "Principal", id: "tsub_fixture" },
    permissions: ["app.invoke"],
    delivery: { type: "oauth2" },
  },
  status: { phase: "Ready", observedInterfaceRevision: 1 },
} satisfies InterfaceBinding;
void binding;

const discovery = createTakosumiWellKnownDocument({
  origin: "https://host.example/",
});
console.log(JSON.stringify({
  apiVersion: TAKOSUMI_API_VERSION,
  apiBaseUrl: discovery.apiBaseUrl,
  interfaceNameValid: isValidInterfaceName(iface.metadata.name),
  notificationGateway: normalizeNotificationPusherGatewayUrl("https://push.example"),
  oidcUserinfo: TAKOSUMI_ACCOUNTS_USERINFO_PATH,
  uiInterfaceType: UI_SURFACE_INTERFACE_TYPE,
}));
`,
  );
  await writeFile(
    join(fixture, "forbidden-imports.ts"),
    `// @ts-expect-error the package root remains the 2.0 runtime, not contract/index.ts
import type { InstallConfig } from "@takosjp/takosumi-contract";
// @ts-expect-error discovery has no installation authority
import type { InstallConfig as DiscoveryInstallConfig } from "@takosjp/takosumi-contract/discovery";
// @ts-expect-error discovery has no provider authority
import type { ProviderBinding } from "@takosjp/takosumi-contract/discovery";
// @ts-expect-error discovery has no Run lifecycle authority
import type { Run } from "@takosjp/takosumi-contract/discovery";
// @ts-expect-error app-facing runtime Interfaces exclude host blueprints
import type { CapsuleInterfaceBlueprint } from "@takosjp/takosumi-contract/runtime-interfaces";
// @ts-expect-error app-facing runtime Interfaces exclude host projections
import type { InterfaceProjectionSink } from "@takosjp/takosumi-contract/runtime-interfaces";
// @ts-expect-error app-facing runtime Interfaces exclude create authority
import type { CreateInterfaceRequest } from "@takosjp/takosumi-contract/runtime-interfaces";
// @ts-expect-error app-facing runtime Interfaces exclude host provenance
import type { InterfaceInputProvenance } from "@takosjp/takosumi-contract/runtime-interfaces";
// @ts-expect-error interface display policy remains application-owned
import * as InterfaceDisplay from "@takosjp/takosumi-contract/interface-display";
// @ts-expect-error internal crypto is not a package export
import * as InternalCrypto from "@takosjp/takosumi-contract/internal-crypto";
// @ts-expect-error IP classification is not a package export
import * as IpClassification from "@takosjp/takosumi-contract/reference/ip-classification";
// @ts-expect-error private API contracts are not package exports
import * as InternalApi from "@takosjp/takosumi-contract/internal-api";
// @ts-expect-error provider adapters are not package exports
import * as Providers from "@takosjp/takosumi-contract/providers";
`,
  );
}

function parseDryRunFiles(output: string): readonly string[] {
  return [...output.matchAll(/^packed\s+\S+\s+(.+)$/gmu)]
    .map((match) => match[1])
    .sort();
}

async function readTarFiles(
  tarball: string,
  paths: readonly string[],
): Promise<string> {
  const contents: string[] = [];
  for (const path of paths) {
    const result = await runChecked(
      ["tar", "-xOf", tarball, `package/${path}`],
      ROOT,
    );
    contents.push(result.stdout);
  }
  return contents.join("\n");
}

async function runChecked(
  command: readonly string[],
  cwd: string,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  return { stdout, stderr };
}
