import { expect, test } from "bun:test";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "../../../helpers/assert.ts";
import { TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND } from "@takosjp/takosumi-accounts-contract";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as nodeJoin } from "node:path";
import {
  buildInstallationExportArchiveFiles,
  createMetadataOnlyInstallationExportWorker,
  writeInstallationExportTarZst,
} from "../../../../accounts/service/src/export-archive.ts";
import { signExportDownloadUrl } from "../../../../accounts/service/src/export-download-url.ts";
import {
  buildInstallationExportBundle,
  parseAccountsInstallationExportBundle,
  planInstallationImport,
} from "../../../../accounts/service/src/export-bundle.ts";

type CommandOutput = {
  success: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
};

type TestCommand = {
  output(): Promise<CommandOutput>;
};

function command(
  executable: string,
  options: { args?: readonly string[] },
): TestCommand {
  return {
    output: () => runCommand(executable, options.args ?? []),
  };
}

async function runCommand(
  executable: string,
  args: readonly string[],
): Promise<CommandOutput> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        success: code === 0,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

async function makeTempDir(options: { prefix?: string } = {}): Promise<string> {
  return await mkdtemp(
    nodeJoin(tmpdir(), options.prefix ?? "takosumi-accounts-export-"),
  );
}

async function removePath(
  target: string,
  options: { recursive?: boolean } = {},
): Promise<void> {
  await rm(target, { recursive: options.recursive ?? false, force: true });
}

async function sha256File(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await readFile(path));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

test("installation export bundle import plan rewrites OIDC issuer", () => {
  const sourceIssuer = "https://accounts.source.test";
  const targetIssuer = "https://accounts.target.test";
  const bundle = sampleExportBundle(sourceIssuer);

  expect(bundle.kind).toEqual(
    TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND,
  );
  expect(bundle.source.commit).toEqual(
    "0123456789abcdef0123456789abcdef01234567",
  );
  expect(bundle.installation.billingAccountId).toEqual("billing_source");
  expect(bundle.runtimeTarget?.runtimeTargetId).toEqual("rtb_source");
  expect(bundle.oidcClient?.issuerUrl).toEqual(sourceIssuer);
  expect(bundle.oidcClient?.serviceBinding).toEqual("auth");
  expect(bundle.oidcClient?.servicePath).toEqual("takosumi.identity.oidc");
  expect(
    bundle.oidcClient && !("namespacePath" in bundle.oidcClient),
  ).toBeTruthy();
  expect(
    bundle.serviceBindings.map((binding) => binding.serviceBindingId),
  ).toEqual(["bind_auth", "bind_domain"]);
  expect(bundle.serviceGrants.map((grant) => grant.serviceGrantId)).toEqual([
    "grant_logs",
    "grant_threads",
  ]);

  const plan = planInstallationImport({
    bundle,
    targetIssuer,
    targetAccountId: "acct_target",
    targetSpaceId: "space_target",
    targetInstallationId: "inst_target",
    createdBySubject: "tsub_target",
  });
  const request = plan.request as {
    installationId: string;
    accountId: string;
    spaceId: string;
    mode: string;
    oidcClients: readonly Record<string, unknown>[];
    serviceBindings: readonly {
      name: string;
      configRef: string;
      declaration: { exportTemplate: Record<string, unknown> };
    }[];
    serviceGrants: readonly Record<string, unknown>[];
  };

  expect(plan.sourceIssuer).toEqual(sourceIssuer);
  expect(plan.targetIssuer).toEqual(targetIssuer);
  expect(request.installationId).toEqual("inst_target");
  expect(request.accountId).toEqual("acct_target");
  expect(request.spaceId).toEqual("space_target");
  expect(request.mode).toEqual("self-hosted");
  expect(request.oidcClients[0].issuerUrl).toEqual(targetIssuer);
  expect(request.oidcClients[0].serviceBinding).toEqual("auth");
  expect(request.oidcClients[0].servicePath).toEqual("takosumi.identity.oidc");
  expect(!("namespacePath" in request.oidcClients[0])).toBeTruthy();
  expect(request.serviceGrants.map((grant) => grant.serviceGrantId)).toEqual([
    "grant_threads",
  ]);
  expect(request.serviceGrants[0].scope).toEqual({
    pathPrefix: "threads/",
    apiKey: "[REDACTED]",
    authorization: "[REDACTED]",
    databaseUrl: "[REDACTED]",
  });
  expect(JSON.stringify(request.serviceGrants)).not.toContain(
    "sk-export-grant-scope",
  );
  expect(JSON.stringify(request.serviceGrants)).not.toContain(
    "export-grant-token",
  );
  expect(JSON.stringify(request.serviceGrants)).not.toContain("exportpass");

  const authBinding = request.serviceBindings.find(
    (binding) => binding.name === "auth",
  );
  expect(authBinding).toBeTruthy();
  expect(!("secretRefs" in authBinding!)).toBeTruthy();
  expect(
    !("secretRefs" in authBinding!.declaration.exportTemplate),
  ).toBeTruthy();
  expect(authBinding.declaration.exportTemplate.configRef).toEqual(
    `${targetIssuer}/v1/installation-projections/inst_source/service-bindings/auth/oidc-client/toc_source`,
  );
  expect(!JSON.stringify(request).includes(sourceIssuer)).toBeTruthy();
  expect(!JSON.stringify(bundle).includes("/secrets/")).toBeTruthy();
});

test("installation export bundle import plan rewrites only the exact source origin", () => {
  // Origin-boundary guard: the source issuer host is a leading substring of an
  // unrelated host. A naive substring rewrite would corrupt the superstring
  // URL; origin-aware rewriting must leave it untouched and rewrite only the
  // exact-origin redirect URI.
  const sourceIssuer = "https://acc.example";
  const targetIssuer = "https://accounts.target.test";
  const superstringRedirect = "https://acc.example.evil.test/callback";
  const exactOriginRedirect = "https://acc.example/auth/callback";

  const bundle = sampleExportBundle(sourceIssuer);
  const bundleWithRedirects = {
    ...bundle,
    oidcClient: {
      ...bundle.oidcClient!,
      redirectUris: [exactOriginRedirect, superstringRedirect],
    },
  };

  const plan = planInstallationImport({
    bundle: bundleWithRedirects,
    targetIssuer,
    targetAccountId: "acct_target",
    targetSpaceId: "space_target",
    targetInstallationId: "inst_target",
    createdBySubject: "tsub_target",
  });
  const request = plan.request as {
    oidcClients: readonly { redirectUris: readonly string[] }[];
  };

  expect(request.oidcClients[0].redirectUris).toEqual([
    // Exact-origin URI: origin rewritten, path preserved.
    "https://accounts.target.test/auth/callback",
    // Superstring host: left untouched (NOT mangled into the target origin).
    "https://acc.example.evil.test/callback",
  ]);
});

test("installation export bundle parser accepts stored OIDC namespacePath", () => {
  const stored = JSON.parse(
    JSON.stringify(sampleExportBundle("https://accounts.source.test")),
  ) as Record<string, unknown>;
  const oidcClient = stored.oidcClient as Record<string, unknown>;
  oidcClient.namespacePath = oidcClient.servicePath;
  delete oidcClient.servicePath;

  const parsed = parseAccountsInstallationExportBundle(stored);

  expect(parsed.oidcClient?.servicePath).toEqual("takosumi.identity.oidc");
  expect(parsed.oidcClient?.namespacePath).toEqual("takosumi.identity.oidc");
});

test("installation export import plan drops legacy secretRefs", () => {
  const sourceIssuer = "https://accounts.source.test";
  const stored = JSON.parse(JSON.stringify(sampleExportBundle(sourceIssuer)));
  stored.serviceBindings[0].template.secretRefs = [
    `${sourceIssuer}/v1/installation-projections/inst_source/service-bindings/auth/secrets/client-secret`,
  ];
  const bundle = parseAccountsInstallationExportBundle(stored);

  const plan = planInstallationImport({
    bundle,
    targetIssuer: "https://accounts.target.test",
    targetAccountId: "acct_target",
    targetSpaceId: "space_target",
    targetInstallationId: "inst_target",
    createdBySubject: "tsub_target",
  });

  expect(JSON.stringify(plan.request)).not.toContain("secretRefs");
  expect(JSON.stringify(plan.request)).not.toContain("/secrets/");
});

test("installation export archive writer emits canonical bundle payload", async () => {
  const sourceIssuer = "https://accounts.source.test";
  const bundle = sampleExportBundle(sourceIssuer);
  const files = await buildInstallationExportArchiveFiles(bundle);

  expect(files.map((file) => file.path)).toEqual([
    "takos-export/bundle.json",
    "takos-export/installation.json",
    "takos-export/source.json",
    "takos-export/artifact.yml",
    "takos-export/data/README.md",
    "takos-export/service-bindings/template.yml",
    "takos-export/oidc/service-binding-template.json",
    "takos-export/docs/restore.md",
  ]);
  expect(files[0].content as string).toContain(
    TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND,
  );
  expect(files.at(-1)?.content as string).toContain(
    "Takosumi deploy-control restore/apply flow",
  );
  const oidcTemplate = files.find(
    (file) => file.path === "takos-export/oidc/service-binding-template.json",
  );
  expect(oidcTemplate).toBeTruthy();
  expect(JSON.parse(oidcTemplate.content as string)).toEqual({
    kind: "takosumi.accounts.oidc-service-binding-template@v1",
    version: "v1",
    installationId: "inst_source",
    sourceIssuer,
    oidcClient: {
      serviceBinding: "auth",
      servicePath: "takosumi.identity.oidc",
      issuerUrl: sourceIssuer,
      redirectUris: ["https://takos.example.test/auth/oidc/callback"],
      allowedScopes: ["openid", "profile", "threads:read"],
      subjectMode: "pairwise",
      tokenEndpointAuthMethod: "client_secret_post",
    },
    serviceBinding: {
      name: "auth",
      kind: "identity.oidc",
      configRef: `${sourceIssuer}/v1/installation-projections/inst_source/service-bindings/auth/oidc-client/toc_source`,
    },
  });
  const root = await makeTempDir({
    prefix: "takosumi-accounts-export-archive-",
  });
  try {
    const outputPath = join(root, "takos-export.tar.zst");
    await writeInstallationExportTarZst({ bundle, outputPath });

    const list = await commandOutputText(
      command("tar", {
        args: ["--use-compress-program=zstd", "-tf", outputPath],
      }),
    );
    expect(list).toContain("takos-export/bundle.json");
    expect(list).toContain("takos-export/docs/restore.md");

    const bundleJson = await commandOutputText(
      command("tar", {
        args: [
          "--use-compress-program=zstd",
          "-xOf",
          outputPath,
          "takos-export/bundle.json",
        ],
      }),
    );
    const parsed = JSON.parse(bundleJson);
    expect(parsed.kind).toEqual(
      TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND,
    );
    expect(parsed.source.commit).toEqual(
      "0123456789abcdef0123456789abcdef01234567",
    );
  } finally {
    await removePath(root, { recursive: true });
  }
});

test("installation export archive writer embeds artifact descriptor content", async () => {
  const bundle = sampleExportBundle("https://accounts.source.test");
  const files = await buildInstallationExportArchiveFiles(bundle, [], {
    artifactDescriptorContent: [
      "apiVersion: v1",
      "kind: SourceArtifactDescriptor",
      "resources:",
      "  - type: web-service",
      "    name: app",
      "",
    ].join("\n"),
  });

  const artifactDescriptor = files.find(
    (file) => file.path === "takos-export/artifact.yml",
  );
  expect(artifactDescriptor).toBeTruthy();
  expect(artifactDescriptor.content).toEqual(
    [
      "apiVersion: v1",
      "kind: SourceArtifactDescriptor",
      "resources:",
      "  - type: web-service",
      "    name: app",
      "",
    ].join("\n"),
  );
});

test("installation export archive writer includes deterministic provider data files", async () => {
  const sourceIssuer = "https://accounts.source.test";
  const bundle = sampleExportBundle(sourceIssuer);
  const files = await buildInstallationExportArchiveFiles(bundle, [
    {
      path: "postgres/dump.sql",
      mediaType: "application/sql",
      content: "select 1;\n",
    },
    {
      path: "takos-export/data/blobs/profile.json",
      mediaType: "application/json",
      content: '{"ok":true}\n',
    },
  ]);

  expect(files.map((file) => file.path)).toEqual([
    "takos-export/bundle.json",
    "takos-export/installation.json",
    "takos-export/source.json",
    "takos-export/artifact.yml",
    "takos-export/data/manifest.json",
    "takos-export/data/blobs/profile.json",
    "takos-export/data/postgres/dump.sql",
    "takos-export/service-bindings/template.yml",
    "takos-export/oidc/service-binding-template.json",
    "takos-export/docs/restore.md",
  ]);
  const manifest = files.find(
    (file) => file.path === "takos-export/data/manifest.json",
  );
  expect(manifest).toBeTruthy();
  expect(typeof manifest.content).toEqual("string");
  const parsedManifest = JSON.parse(manifest.content as string);
  expect(parsedManifest.kind).toEqual(
    "takosumi.accounts.installation-export-data-manifest@v1",
  );
  expect(parsedManifest.files).toEqual([
    {
      path: "takos-export/data/blobs/profile.json",
      mediaType: "application/json",
      byteLength: 12,
      contentDigest:
        "sha256:e5f1eb4d806641698a35efe20e098efd20d7d57a9b90ee69079d5bb650920726",
    },
    {
      path: "takos-export/data/postgres/dump.sql",
      mediaType: "application/sql",
      byteLength: 10,
      contentDigest:
        "sha256:4a45092ccf992ea92250053a80b931b787924ba61648f420555511b84f10ab6c",
    },
  ]);

  const root = await makeTempDir({
    prefix: "takosumi-accounts-export-data-",
  });
  try {
    const outputPath = join(root, "takos-export.tar.zst");
    await writeInstallationExportTarZst({
      bundle,
      outputPath,
      dataFiles: [
        {
          path: "postgres/dump.sql",
          mediaType: "application/sql",
          content: "select 1;\n",
        },
      ],
    });

    const list = await commandOutputText(
      command("tar", {
        args: ["--use-compress-program=zstd", "-tf", outputPath],
      }),
    );
    expect(list).toContain("takos-export/data/manifest.json");
    expect(list).toContain("takos-export/data/postgres/dump.sql");
    const dump = await commandOutputText(
      command("tar", {
        args: [
          "--use-compress-program=zstd",
          "-xOf",
          outputPath,
          "takos-export/data/postgres/dump.sql",
        ],
      }),
    );
    expect(dump).toEqual("select 1;\n");
  } finally {
    await removePath(root, { recursive: true });
  }
});

test("installation export archive rejects unsafe provider data paths", async () => {
  const bundle = sampleExportBundle("https://accounts.source.test");

  await assertRejects(
    () =>
      buildInstallationExportArchiveFiles(bundle, [
        {
          path: "../secret.txt",
          content: "secret\n",
        },
      ]),
    TypeError,
    "must stay under takos-export/data",
  );
  await assertRejects(
    () =>
      buildInstallationExportArchiveFiles(bundle, [
        {
          path: "takos-export/bundle.json",
          content: "overwrite\n",
        },
      ]),
    TypeError,
    "must stay under takos-export/data",
  );
  await assertRejects(
    () =>
      buildInstallationExportArchiveFiles(bundle, [
        {
          path: "takos-export/data/manifest.json",
          content: "{}\n",
        },
      ]),
    TypeError,
    "reserved",
  );
});

test("metadata-only export worker writes archive and returns download URL", async () => {
  const bundle = sampleExportBundle("https://accounts.source.test");
  const root = await makeTempDir({
    prefix: "takosumi-accounts-export-worker-",
  });
  try {
    const worker = createMetadataOnlyInstallationExportWorker({
      outputDirectory: root,
      downloadBaseUrl: "https://downloads.example.test/accounts/exports",
      ttlMs: 60_000,
      now: () => new Date("2026-05-09T00:00:00.000Z"),
    });
    const result = await worker({
      installation: {
        installationId: "inst_source",
        accountId: "acct_source",
        spaceId: "space_source",
        appId: "takos.chat",
        sourceGitUrl: "https://github.com/takos/takos",
        sourceRef: "v1.2.3",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        planDigest: "sha256:app",
        artifactDigest: "sha256:compiled",
        mode: "dedicated",
        status: "ready",
        createdBySubject: "tsub_source",
        createdAt: 1778284800000,
        updatedAt: 1778284800000,
      },
      operationId: "op_worker",
      request: {
        includeData: false,
        format: "bundle",
        encryption: { method: "none", recipients: [] },
        scope: {},
      },
      bundle,
    });

    expect(result.downloadUrl).toEqual(
      "https://downloads.example.test/accounts/exports/takos-export-op_worker.tar.zst",
    );
    expect(result.downloadExpiresAt).toEqual("2026-05-09T00:01:00.000Z");
    expect(result.archiveDigest).toEqual(
      await sha256File(join(root, "takos-export-op_worker.tar.zst")),
    );
    const list = await commandOutputText(
      command("tar", {
        args: [
          "--use-compress-program=zstd",
          "-tf",
          join(root, "takos-export-op_worker.tar.zst"),
        ],
      }),
    );
    expect(list).toContain("takos-export/bundle.json");
  } finally {
    await removePath(root, { recursive: true });
  }
});

test("export download URLs require HTTPS except loopback HTTP", async () => {
  const signedLoopback = await signExportDownloadUrl(
    "http://127.0.0.1:8787/exports/takos-export.tar.zst",
    {
      secret: "download-secret",
      now: () => new Date("2026-05-09T00:00:00.000Z").getTime(),
    },
  );
  expect(
    signedLoopback.url.startsWith("http://127.0.0.1:8787/exports/"),
  ).toEqual(true);

  await assertRejects(
    () =>
      signExportDownloadUrl(
        "http://downloads.example.test/exports/takos-export.tar.zst",
        { secret: "download-secret" },
      ),
    TypeError,
    "https:// or loopback http://",
  );
  await assertRejects(
    () =>
      signExportDownloadUrl(
        "https://user:password@downloads.example.test/exports/takos-export.tar.zst",
        { secret: "download-secret" },
      ),
    TypeError,
    "embedded credentials",
  );
  expect(() =>
    createMetadataOnlyInstallationExportWorker({
      outputDirectory: "/tmp/takosumi-exports",
      downloadBaseUrl: "http://downloads.example.test/accounts/exports",
    }),
  ).toThrow("https:// or loopback http://");
});

test("metadata-only export worker attaches provider data when requested", async () => {
  const bundle = sampleExportBundle("https://accounts.source.test");
  const root = await makeTempDir({
    prefix: "takosumi-accounts-export-worker-data-",
  });
  let providerIncludeData: boolean | undefined;
  try {
    const ageExecutable = await writeFakeAgeExecutable(root);
    const worker = createMetadataOnlyInstallationExportWorker({
      outputDirectory: root,
      downloadBaseUrl: "https://downloads.example.test/accounts/exports",
      ttlMs: 60_000,
      ageExecutable,
      now: () => new Date("2026-05-09T00:00:00.000Z"),
      dataProvider: (input) => {
        providerIncludeData = input.request.includeData;
        return [
          {
            path: "postgres/dump.sql",
            mediaType: "application/sql",
            content: "select 1;\n",
          },
        ];
      },
    });
    await worker({
      installation: {
        installationId: "inst_source",
        accountId: "acct_source",
        spaceId: "space_source",
        appId: "takos.chat",
        sourceGitUrl: "https://github.com/takos/takos",
        sourceRef: "v1.2.3",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        planDigest: "sha256:app",
        artifactDigest: "sha256:compiled",
        mode: "dedicated",
        status: "ready",
        createdBySubject: "tsub_source",
        createdAt: 1778284800000,
        updatedAt: 1778284800000,
      },
      operationId: "op_worker_data",
      request: {
        includeData: true,
        format: "bundle",
        encryption: {
          method: "age",
          recipients: ["age1takosumiexportrecipient"],
        },
        scope: {},
      },
      bundle,
    });

    expect(providerIncludeData).toEqual(true);
    const manifest = await commandOutputText(
      command("tar", {
        args: [
          "--use-compress-program=zstd",
          "-xOf",
          join(root, "takos-export-op_worker_data.tar.zst.age"),
          "takos-export/data/manifest.json",
        ],
      }),
    );
    expect(manifest).toContain("takos-export/data/postgres/dump.sql");
  } finally {
    await removePath(root, { recursive: true });
  }
});

test("metadata-only export worker rejects data export without age encryption", async () => {
  const bundle = sampleExportBundle("https://accounts.source.test");
  const root = await makeTempDir({
    prefix: "takosumi-accounts-export-worker-plain-data-",
  });
  try {
    const worker = createMetadataOnlyInstallationExportWorker({
      outputDirectory: root,
      downloadBaseUrl: "https://downloads.example.test/accounts/exports",
      dataProvider: () => [
        {
          path: "postgres/dump.sql",
          mediaType: "application/sql",
          content: "select 1;\n",
        },
      ],
    });

    await assertRejects(
      () =>
        worker({
          installation: {
            installationId: "inst_source",
            accountId: "acct_source",
            spaceId: "space_source",
            appId: "takos.chat",
            sourceGitUrl: "https://github.com/takos/takos",
            sourceRef: "v1.2.3",
            sourceCommit: "0123456789abcdef0123456789abcdef01234567",
            planDigest: "sha256:app",
            artifactDigest: "sha256:compiled",
            mode: "dedicated",
            status: "ready",
            createdBySubject: "tsub_source",
            createdAt: 1778284800000,
            updatedAt: 1778284800000,
          },
          operationId: "op_plain_data",
          request: {
            includeData: true,
            format: "bundle",
            encryption: { method: "none", recipients: [] },
            scope: {},
          },
          bundle,
        }),
      TypeError,
      "export includeData requires age encryption",
    );
  } finally {
    await removePath(root, { recursive: true });
  }
});

test("metadata-only export worker attaches artifact descriptor when configured", async () => {
  const bundle = sampleExportBundle("https://accounts.source.test");
  const root = await makeTempDir({
    prefix: "takosumi-accounts-export-worker-manifest-",
  });
  let providerOperationId: string | undefined;
  try {
    const worker = createMetadataOnlyInstallationExportWorker({
      outputDirectory: root,
      downloadBaseUrl: "https://downloads.example.test/accounts/exports",
      ttlMs: 60_000,
      now: () => new Date("2026-05-09T00:00:00.000Z"),
      artifactDescriptorProvider: (input) => {
        providerOperationId = input.operationId;
        return [
          "apiVersion: v1",
          "kind: SourceArtifactDescriptor",
          "resources:",
          "  - type: web-service",
          "    name: app",
        ].join("\n");
      },
    });
    await worker({
      installation: {
        installationId: "inst_source",
        accountId: "acct_source",
        spaceId: "space_source",
        appId: "takos.chat",
        sourceGitUrl: "https://github.com/takos/takos",
        sourceRef: "v1.2.3",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        planDigest: "sha256:app",
        artifactDigest: "sha256:compiled",
        mode: "dedicated",
        status: "ready",
        createdBySubject: "tsub_source",
        createdAt: 1778284800000,
        updatedAt: 1778284800000,
      },
      operationId: "op_worker_manifest",
      request: {
        includeData: false,
        format: "bundle",
        encryption: { method: "none", recipients: [] },
        scope: {},
      },
      bundle,
    });

    expect(providerOperationId).toEqual("op_worker_manifest");
    const manifest = await commandOutputText(
      command("tar", {
        args: [
          "--use-compress-program=zstd",
          "-xOf",
          join(root, "takos-export-op_worker_manifest.tar.zst"),
          "takos-export/artifact.yml",
        ],
      }),
    );
    expect(manifest).toContain("apiVersion: v1");
    expect(manifest).toContain("name: app");
  } finally {
    await removePath(root, { recursive: true });
  }
});

test("metadata-only export worker keeps prefixed static archive paths readable", async () => {
  const bundle = sampleExportBundle("https://accounts.source.test");
  const root = await makeTempDir({
    prefix: "takosumi-accounts-export-worker-static-prefix-",
  });
  try {
    const worker = createMetadataOnlyInstallationExportWorker({
      outputDirectory: root,
      downloadBaseUrl: "https://downloads.example.test",
      objectKeyPrefix: "accounts/exports",
      ttlMs: 60_000,
      now: () => new Date("2026-05-09T00:00:00.000Z"),
    });
    const result = await worker({
      installation: {
        installationId: "inst_source",
        accountId: "acct_source",
        spaceId: "space_source",
        appId: "takos.chat",
        sourceGitUrl: "https://github.com/takos/takos",
        sourceRef: "v1.2.3",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        planDigest: "sha256:app",
        artifactDigest: "sha256:compiled",
        mode: "dedicated",
        status: "ready",
        createdBySubject: "tsub_source",
        createdAt: 1778284800000,
        updatedAt: 1778284800000,
      },
      operationId: "op_static_prefix",
      request: {
        includeData: false,
        format: "bundle",
        encryption: { method: "none", recipients: [] },
        scope: {},
      },
      bundle,
    });

    expect(result.downloadUrl).toEqual(
      "https://downloads.example.test/accounts/exports/takos-export-op_static_prefix.tar.zst",
    );
    const copiedPath = join(
      root,
      "accounts",
      "exports",
      "takos-export-op_static_prefix.tar.zst",
    );
    const list = await commandOutputText(
      command("tar", {
        args: ["--use-compress-program=zstd", "-tf", copiedPath],
      }),
    );
    expect(list).toContain("takos-export/bundle.json");
  } finally {
    await removePath(root, { recursive: true });
  }
});

test("metadata-only export worker uploads archive through injectable object-store uploader", async () => {
  const bundle = sampleExportBundle("https://accounts.source.test");
  const root = await makeTempDir({
    prefix: "takosumi-accounts-export-worker-upload-",
  });
  const uploads: {
    objectKey: string;
    contentType: string;
    contentEncoding?: string;
    downloadExpiresAt: string;
    metadata: Record<string, string>;
    bytes: Uint8Array;
  }[] = [];
  try {
    const ageExecutable = await writeFakeAgeExecutable(root);
    const worker = createMetadataOnlyInstallationExportWorker({
      outputDirectory: root,
      objectKeyPrefix: "accounts/exports",
      ttlMs: 60_000,
      now: () => new Date("2026-05-09T00:00:00.000Z"),
      ageExecutable,
      uploader: async (input) => {
        uploads.push({
          objectKey: input.objectKey,
          contentType: input.contentType,
          contentEncoding: input.contentEncoding,
          downloadExpiresAt: input.downloadExpiresAt,
          metadata: input.metadata,
          bytes: await readFile(input.filePath),
        });
        return {
          downloadUrl: `https://object-store.example.test/signed/${input.objectKey}?sig=test`,
          downloadExpiresAt: "2026-05-09T00:00:45.000Z",
        };
      },
    });
    const result = await worker({
      installation: {
        installationId: "inst_source",
        accountId: "acct_source",
        spaceId: "space_source",
        appId: "takos.chat",
        sourceGitUrl: "https://github.com/takos/takos",
        sourceRef: "v1.2.3",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        planDigest: "sha256:app",
        artifactDigest: "sha256:compiled",
        mode: "dedicated",
        status: "ready",
        createdBySubject: "tsub_source",
        createdAt: 1778284800000,
        updatedAt: 1778284800000,
      },
      operationId: "op_upload",
      request: {
        includeData: true,
        format: "bundle",
        encryption: {
          method: "age",
          recipients: ["age1takosumiexportrecipient"],
        },
        scope: { secrets: "templates-only" },
      },
      bundle,
    });

    expect(result.downloadUrl).toEqual(
      "https://object-store.example.test/signed/accounts/exports/takos-export-op_upload.tar.zst.age?sig=test",
    );
    expect(result.downloadExpiresAt).toEqual("2026-05-09T00:00:45.000Z");
    expect(uploads.length).toEqual(1);
    expect(uploads[0].objectKey).toEqual(
      "accounts/exports/takos-export-op_upload.tar.zst.age",
    );
    expect(uploads[0].contentType).toEqual("application/zstd");
    expect(uploads[0].contentEncoding).toEqual("age");
    expect(uploads[0].downloadExpiresAt).toEqual("2026-05-09T00:01:00.000Z");
    expect(uploads[0].metadata).toEqual({
      installationId: "inst_source",
      accountId: "acct_source",
      spaceId: "space_source",
      operationId: "op_upload",
      format: "bundle",
      encryption: "age",
      dataIncluded: "false",
      artifactDescriptorIncluded: "false",
      archiveDigest: result.archiveDigest,
    });
    expect(result.archiveDigest).toEqual(
      await sha256File(join(root, "takos-export-op_upload.tar.zst.age")),
    );
    expect(uploads[0].bytes.byteLength > 0).toBeTruthy();

    const list = await commandOutputText(
      command("tar", {
        args: [
          "--use-compress-program=zstd",
          "-tf",
          join(root, "takos-export-op_upload.tar.zst.age"),
        ],
      }),
    );
    expect(list).toContain("takos-export/bundle.json");
  } finally {
    await removePath(root, { recursive: true });
  }
});

test("metadata-only export worker encrypts archive with age recipients", async () => {
  const bundle = sampleExportBundle("https://accounts.source.test");
  const root = await makeTempDir({
    prefix: "takosumi-accounts-export-worker-age-",
  });
  try {
    const ageExecutable = await writeFakeAgeExecutable(root);
    const worker = createMetadataOnlyInstallationExportWorker({
      outputDirectory: root,
      downloadBaseUrl: "https://downloads.example.test/accounts/exports",
      ttlMs: 60_000,
      ageExecutable,
      now: () => new Date("2026-05-09T00:00:00.000Z"),
    });
    const result = await worker({
      installation: {
        installationId: "inst_source",
        accountId: "acct_source",
        spaceId: "space_source",
        appId: "takos.chat",
        sourceGitUrl: "https://github.com/takos/takos",
        sourceRef: "v1.2.3",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        planDigest: "sha256:app",
        artifactDigest: "sha256:compiled",
        mode: "dedicated",
        status: "ready",
        createdBySubject: "tsub_source",
        createdAt: 1778284800000,
        updatedAt: 1778284800000,
      },
      operationId: "op_worker_age",
      request: {
        includeData: true,
        format: "bundle",
        encryption: {
          method: "age",
          recipients: ["age1takosumiexportrecipient"],
        },
        scope: { secrets: "templates-only" },
      },
      bundle,
    });

    expect(result.downloadUrl).toEqual(
      "https://downloads.example.test/accounts/exports/takos-export-op_worker_age.tar.zst.age",
    );
    const encryptedPath = join(root, "takos-export-op_worker_age.tar.zst.age");
    const list = await commandOutputText(
      command("tar", {
        args: ["--use-compress-program=zstd", "-tf", encryptedPath],
      }),
    );
    expect(list).toContain("takos-export/bundle.json");
  } finally {
    await removePath(root, { recursive: true });
  }
});

function sampleExportBundle(sourceIssuer: string) {
  return buildInstallationExportBundle({
    exportedAt: "2026-05-09T00:00:00.000Z",
    installation: {
      installationId: "inst_source",
      accountId: "acct_source",
      spaceId: "space_source",
      appId: "takos.chat",
      billingAccountId: "billing_source",
      sourceGitUrl: "https://github.com/takos/takos",
      sourceRef: "v1.2.3",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      planDigest: "sha256:app",
      artifactDigest: "sha256:compiled",
      mode: "dedicated",
      status: "ready",
      createdBySubject: "tsub_source",
      createdAt: 1778284800000,
      updatedAt: 1778284800000,
    },
    runtimeBinding: {
      runtimeBindingId: "rtb_source",
      installationId: "inst_source",
      mode: "dedicated",
      targetType: "dedicated",
      targetId: "dedicated://source/runtime",
      createdAt: 1778284800000,
      updatedAt: 1778284800000,
    },
    oidcClient: {
      clientId: "toc_source",
      installationId: "inst_source",
      namespacePath: "takosumi.identity.oidc",
      issuerUrl: sourceIssuer,
      redirectUris: ["https://takos.example.test/auth/oidc/callback"],
      allowedScopes: ["openid", "profile", "threads:read"],
      subjectMode: "pairwise",
      tokenEndpointAuthMethod: "client_secret_post",
      createdAt: 1778284800000,
      updatedAt: 1778284800000,
    },
    bindings: [
      {
        bindingId: "bind_auth",
        installationId: "inst_source",
        name: "auth",
        kind: "identity.oidc",
        configRef: `${sourceIssuer}/v1/installation-projections/inst_source/service-bindings/auth/oidc-client/toc_source`,
        secretRefs: [
          `${sourceIssuer}/v1/installation-projections/inst_source/service-bindings/auth/secrets/client-secret`,
        ],
        createdAt: 1778284800000,
        updatedAt: 1778284800000,
      },
      {
        bindingId: "bind_domain",
        installationId: "inst_source",
        name: "domain",
        kind: "protocol.http.api",
        configRef: "takosumi-accounts://installations/inst_source/domain/main",
        secretRefs: [],
        createdAt: 1778284800000,
        updatedAt: 1778284800000,
      },
    ],
    grants: [
      {
        grantId: "grant_threads",
        installationId: "inst_source",
        capability: "threads:read",
        scope: {
          pathPrefix: "threads/",
          apiKey: "sk-export-grant-scope",
          authorization: "Bearer export-grant-token",
          databaseUrl: "postgres://user:exportpass@db.example/takos",
        },
        grantedAt: 1778284800000,
      },
      {
        grantId: "grant_logs",
        installationId: "inst_source",
        capability: "logs.read.own",
        scope: {},
        grantedAt: 1778284800000,
        revokedAt: 1778284860000,
      },
    ],
    events: [
      {
        eventId: "evt_create",
        installationId: "inst_source",
        eventType: "installation.created",
        payload: {},
        eventHash: "sha256:event",
        createdAt: 1778284800000,
      },
    ],
  });
}

async function writeFakeAgeExecutable(root: string): Promise<string> {
  const path = join(root, "fake-age.sh");
  await writeFile(
    path,
    `#!/bin/sh
set -eu
out=""
input=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      shift
      out="$1"
      ;;
    -r|-i)
      shift
      ;;
    -d)
      ;;
    *)
      input="$1"
      ;;
  esac
  shift
done
cp "$input" "$out"
`,
  );
  await chmod(path, 0o755);
  return path;
}

async function commandOutputText(command: TestCommand): Promise<string> {
  const output = await command.output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
  return new TextDecoder().decode(output.stdout);
}
