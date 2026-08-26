import { expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import {
  applyD1AccountsMigrationBatch,
  digestD1AccountsValue,
  loadD1AccountsMigrationCatalog,
  type D1AccountsMigrationDatabase,
} from "../../../accounts/service/src/d1-migrations.ts";
import {
  applyPlannedD1AccountsMigrations,
  buildD1AccountsMigrationPlan,
  statusPlannedD1AccountsMigrations,
  verifyPlannedD1AccountsMigrations,
} from "../../../cli/src/cli-accounts-d1.ts";
import {
  inspectAccountsD1SourceCheckout,
  runAccountsMigrateD1,
} from "../../../cli/src/cli-accounts-commands.ts";
import {
  nodeOwnerPrivateEvidenceRuntime,
  writeNewOwnerPrivateEvidenceJson,
} from "../../../cli/src/owner-private-evidence.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const SOURCE_COMMIT = "abcdef0123456789abcdef0123456789abcdef01";
const CLEAN_SOURCE_CHECKOUT = {
  inspectSourceCheckout: () =>
    Promise.resolve({ commit: SOURCE_COMMIT, status: "" }),
} as const;

test("Accounts D1 apply requires all confirmations before remote I/O and uses one atomic batch for v4", async () => {
  const catalog = await loadD1AccountsMigrationCatalog();
  const backing = new SqliteFakeD1();
  for (const migration of catalog.migrations.slice(0, 4)) {
    await applyD1AccountsMigrationBatch(backing, migration, 1_000 + migration.version);
  }
  let prepareCalls = 0;
  let batchCalls = 0;
  const database: D1AccountsMigrationDatabase = {
    prepare(sql) {
      prepareCalls += 1;
      return backing.prepare(sql);
    },
    batch(statements) {
      batchCalls += 1;
      return backing.batch(statements);
    },
  };
  const plan = await buildD1AccountsMigrationPlan({
    sourceCommit: SOURCE_COMMIT,
    environment: "production",
    accountId: "account_123",
    databaseId: "database_456",
    backupEvidenceDigest: `sha256:${"b".repeat(64)}`,
  });

  await expect(
    applyPlannedD1AccountsMigrations({
      database,
      catalog,
      plan,
      confirmSourceDigest: plan.sourceDigest,
      confirmCatalogDigest: `sha256:${"0".repeat(64)}`,
      confirmTargetDigest: plan.targetDigest,
      confirmConfigurationDigest: plan.configurationDigest,
      now: () => 2_000,
    }),
  ).rejects.toThrow("catalog_confirmation_mismatch");
  expect(prepareCalls).toBe(0);
  expect(batchCalls).toBe(0);

  await expect(
    applyPlannedD1AccountsMigrations({
      database,
      catalog,
      plan,
      confirmSourceDigest: plan.sourceDigest,
      confirmCatalogDigest: plan.catalogDigest,
      confirmTargetDigest: plan.targetDigest,
      confirmConfigurationDigest: `sha256:${"0".repeat(64)}`,
      now: () => 2_000,
    }),
  ).rejects.toThrow("configuration_confirmation_mismatch");
  expect(prepareCalls).toBe(0);
  expect(batchCalls).toBe(0);

  const reboundPlan = {
    ...plan,
    backupEvidenceDigest: `sha256:${"c".repeat(64)}`,
  };
  await expect(
    applyPlannedD1AccountsMigrations({
      database,
      catalog,
      plan: reboundPlan,
      confirmSourceDigest: reboundPlan.sourceDigest,
      confirmCatalogDigest: reboundPlan.catalogDigest,
      confirmTargetDigest: reboundPlan.targetDigest,
      confirmConfigurationDigest: reboundPlan.configurationDigest,
      now: () => 2_000,
    }),
  ).rejects.toThrow("configuration_confirmation_mismatch");
  expect(prepareCalls).toBe(0);
  expect(batchCalls).toBe(0);

  const report = await applyPlannedD1AccountsMigrations({
    database,
    catalog,
    plan,
    confirmSourceDigest: plan.sourceDigest,
    confirmCatalogDigest: plan.catalogDigest,
    confirmTargetDigest: plan.targetDigest,
    confirmConfigurationDigest: plan.configurationDigest,
    now: () => 2_000,
  });
  expect(batchCalls).toBe(1);
  expect(report.applied).toEqual([4]);
  expect(report.skipped).toEqual([0, 1, 2, 3]);
  expect(report.lostAcknowledgementReconciled).toEqual([]);
  expect(report).not.toHaveProperty("accountId");
  expect(report).not.toHaveProperty("databaseId");
});

test("migrate-d1 apply confirms backup-bound configuration before transport construction", async () => {
  const catalog = await loadD1AccountsMigrationCatalog();
  const priorPlan = await buildD1AccountsMigrationPlan({
    sourceCommit: SOURCE_COMMIT,
    environment: "production",
    accountId: "account_123",
    databaseId: "database_456",
    backupEvidenceDigest: `sha256:${"a".repeat(64)}`,
  });
  const currentPlan = await buildD1AccountsMigrationPlan({
    sourceCommit: SOURCE_COMMIT,
    environment: "production",
    accountId: "account_123",
    databaseId: "database_456",
    backupEvidenceDigest: `sha256:${"b".repeat(64)}`,
  });
  expect(currentPlan.sourceDigest).toBe(priorPlan.sourceDigest);
  expect(currentPlan.catalogDigest).toBe(priorPlan.catalogDigest);
  expect(currentPlan.targetDigest).toBe(priorPlan.targetDigest);
  expect(currentPlan.configurationDigest).not.toBe(
    priorPlan.configurationDigest,
  );
  expect(currentPlan.migrationPolicyDigest).toBe(catalog.policyDigest);
  expect(currentPlan.configurationDigest).toBe(
    await digestD1AccountsValue({
      sourceDigest: currentPlan.sourceDigest,
      catalogDigest: currentPlan.catalogDigest,
      targetDigest: currentPlan.targetDigest,
      migrationPolicyDigest: catalog.policyDigest,
      backupEvidenceDigest: currentPlan.backupEvidenceDigest,
    }),
  );

  for (const confirmation of [
    undefined,
    `sha256:${"0".repeat(64)}`,
    priorPlan.configurationDigest,
  ]) {
    const calls = {
      databaseConstructions: 0,
      prepares: 0,
      queries: 0,
      batches: 0,
      bookmarks: 0,
    };
    const stderr: string[] = [];
    const prepared = {
      bind() {
        return prepared;
      },
      run() {
        calls.queries += 1;
        return Promise.reject(new Error("query_must_not_run"));
      },
      first() {
        calls.queries += 1;
        return Promise.reject(new Error("query_must_not_run"));
      },
      all() {
        calls.queries += 1;
        return Promise.reject(new Error("query_must_not_run"));
      },
    };
    const code = await runAccountsMigrateD1(
      [
        "apply",
        "--environment",
        "production",
        "--account-id",
        "account_123",
        "--database-id",
        "database_456",
        "--source-commit",
        SOURCE_COMMIT,
        "--backup-evidence-digest",
        currentPlan.backupEvidenceDigest!,
        "--confirm-source-digest",
        currentPlan.sourceDigest,
        "--confirm-catalog-digest",
        currentPlan.catalogDigest,
        "--confirm-target-digest",
        currentPlan.targetDigest,
        ...(confirmation
          ? ["--confirm-configuration-digest", confirmation]
          : []),
      ],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
      {
        ...CLEAN_SOURCE_CHECKOUT,
        apiToken: "token_must_not_appear",
        catalog,
        createDatabase() {
          calls.databaseConstructions += 1;
          return {
            prepare() {
              calls.prepares += 1;
              return prepared;
            },
            batch() {
              calls.batches += 1;
              return Promise.reject(new Error("batch_must_not_run"));
            },
          };
        },
        async readBookmark() {
          calls.bookmarks += 1;
          return "bookmark_must_not_be_read";
        },
      },
    );
    expect(code).toBe(1);
    expect(JSON.parse(stderr.join("\n"))).toMatchObject({
      failureCode: "configuration_confirmation_mismatch",
    });
    expect(calls).toEqual({
      databaseConstructions: 0,
      prepares: 0,
      queries: 0,
      batches: 0,
      bookmarks: 0,
    });
  }
});

test("Accounts D1 apply requires backup evidence and sends exactly one batch per pending migration", async () => {
  const catalog = await loadD1AccountsMigrationCatalog();
  const database = new SqliteFakeD1();
  const unboundPlan = await buildD1AccountsMigrationPlan({
    sourceCommit: SOURCE_COMMIT,
    environment: "staging",
    accountId: "account_123",
    databaseId: "database_456",
  });
  await expect(
    applyPlannedD1AccountsMigrations({
      database,
      catalog,
      plan: unboundPlan,
      confirmSourceDigest: unboundPlan.sourceDigest,
      confirmCatalogDigest: unboundPlan.catalogDigest,
      confirmTargetDigest: unboundPlan.targetDigest,
      confirmConfigurationDigest: unboundPlan.configurationDigest,
    }),
  ).rejects.toThrow("backup_evidence_digest_required");

  const plan = await productionPlan();
  let batchCalls = 0;
  const observed: D1AccountsMigrationDatabase = {
    prepare: (sql) => database.prepare(sql),
    batch(statements) {
      batchCalls += 1;
      return database.batch(statements);
    },
  };
  const report = await applyWithConfirmations(observed, catalog, plan);
  expect(batchCalls).toBe(catalog.migrations.length);
  expect(report.applied).toEqual([0, 1, 2, 3, 4]);
});

test("migrate-d1 plan makes zero remote calls and transcripts never expose target IDs or token", async () => {
  let databaseCreations = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runAccountsMigrateD1(
    [
      "plan",
      "--environment",
      "production",
      "--account-id",
      "account_secret_identifier",
      "--database-id",
      "database_secret_identifier",
      "--source-commit",
      SOURCE_COMMIT,
    ],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    {
      ...CLEAN_SOURCE_CHECKOUT,
      apiToken: "token_must_not_appear",
      createDatabase() {
        databaseCreations += 1;
        throw new Error("plan_must_not_create_database");
      },
    },
  );
  expect(code).toBe(0);
  expect(stderr).toEqual([]);
  expect(databaseCreations).toBe(0);
  const transcript = stdout.join("\n");
  expect(transcript).not.toContain("account_secret_identifier");
  expect(transcript).not.toContain("database_secret_identifier");
  expect(transcript).not.toContain("token_must_not_appear");
  expect(JSON.parse(transcript)).toMatchObject({
    mode: "plan",
    status: "planned",
    expectedHead: 4,
    expectedCount: 5,
  });
});

test("migrate-d1 binds a clean observed checkout before token or external I/O", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-accounts-source-"));
  const out = join(directory, "must-not-exist.json");
  try {
    const failures: readonly {
      readonly name: string;
      readonly inspect: () => Promise<{
        readonly commit: string;
        readonly status: string;
      }>;
      readonly failureCode: string;
    }[] = [
      {
        name: "commit mismatch",
        inspect: () =>
          Promise.resolve({
            commit: "1111111111111111111111111111111111111111",
            status: "",
          }),
        failureCode: "source_checkout_commit_mismatch",
      },
      {
        name: "dirty tracked file",
        inspect: () =>
          Promise.resolve({ commit: SOURCE_COMMIT, status: " M tracked.ts\n" }),
        failureCode: "source_checkout_dirty",
      },
      {
        name: "untracked file",
        inspect: () =>
          Promise.resolve({ commit: SOURCE_COMMIT, status: "?? private.tmp\n" }),
        failureCode: "source_checkout_dirty",
      },
      {
        name: "git failure",
        inspect: () => Promise.reject(new Error("git failed with a private path")),
        failureCode: "source_checkout_inspection_failed",
      },
      {
        name: "non-checkout",
        inspect: () => Promise.reject(new Error("not a git repository")),
        failureCode: "source_checkout_inspection_failed",
      },
    ];

    for (const failure of failures) {
      const calls = {
        sourceInspections: 0,
        tokenReads: 0,
        databaseConstructions: 0,
        bookmarks: 0,
        fetches: 0,
        batches: 0,
      };
      const stderr: string[] = [];
      const code = await runAccountsMigrateD1(
        [
          "backup-status",
          "--environment",
          "production",
          "--account-id",
          "account_123",
          "--database-id",
          "database_456",
          "--source-commit",
          SOURCE_COMMIT,
          "--out",
          out,
        ],
        { stdout: () => {}, stderr: (line) => stderr.push(line) },
        {
          async inspectSourceCheckout() {
            calls.sourceInspections += 1;
            return await failure.inspect();
          },
          readApiToken() {
            calls.tokenReads += 1;
            return "token_must_not_appear";
          },
          createDatabase() {
            calls.databaseConstructions += 1;
            return {
              prepare() {
                throw new Error("prepare_must_not_run");
              },
              batch() {
                calls.batches += 1;
                return Promise.reject(new Error("batch_must_not_run"));
              },
            };
          },
          async readBookmark() {
            calls.bookmarks += 1;
            return "bookmark_must_not_be_read";
          },
          fetch: async () => {
            calls.fetches += 1;
            throw new Error("fetch_must_not_run");
          },
        },
      );
      expect(code, failure.name).toBe(2);
      expect(stderr, failure.name).toEqual([failure.failureCode]);
      expect(calls, failure.name).toEqual({
        sourceInspections: 1,
        tokenReads: 0,
        databaseConstructions: 0,
        bookmarks: 0,
        fetches: 0,
        batches: 0,
      });
      expect(await Bun.file(out).exists(), failure.name).toBe(false);
    }

    const stdout: string[] = [];
    let tokenReads = 0;
    const code = await runAccountsMigrateD1(
      [
        "plan",
        "--environment",
        "production",
        "--account-id",
        "account_123",
        "--database-id",
        "database_456",
        "--source-commit",
        SOURCE_COMMIT,
      ],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        inspectSourceCheckout: () =>
          Promise.resolve({ commit: SOURCE_COMMIT, status: "" }),
        readApiToken() {
          tokenReads += 1;
          return "token_must_not_be_read_for_plan";
        },
      },
    );
    expect(code).toBe(0);
    expect(tokenReads).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      sourceCommit: SOURCE_COMMIT,
      status: "planned",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Accounts D1 source inspection isolates ambient Git authority and exact root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-accounts-git-"));
  const bin = join(directory, "bin");
  const fakeGit = join(bin, "git");
  const capture = join(directory, "accounts-source-git-capture");
  const sourceRoot = resolve(import.meta.dir, "../../..");
  const previous = {
    PATH: Bun.env.PATH,
    HOME: Bun.env.HOME,
    TMPDIR: Bun.env.TMPDIR,
    GIT_DIR: Bun.env.GIT_DIR,
    GIT_WORK_TREE: Bun.env.GIT_WORK_TREE,
    GIT_CONFIG_GLOBAL: Bun.env.GIT_CONFIG_GLOBAL,
  };
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(directory, ".gitconfig"),
    "[core]\n\tfsmonitor = /must/not/run\n",
  );
  const writeFakeGit = async (topLevel: string, fail = false) => {
    await writeFile(
      fakeGit,
      [
        "#!/bin/sh",
        "set -eu",
        `{ printf 'argv=%s\\n' "$*"; printf 'GIT_DIR=%s\\n' "\${GIT_DIR-unset}"; printf 'GIT_WORK_TREE=%s\\n' "\${GIT_WORK_TREE-unset}"; printf 'GIT_CONFIG_NOSYSTEM=%s\\n' "\${GIT_CONFIG_NOSYSTEM-unset}"; printf 'GIT_CONFIG_GLOBAL=%s\\n' "\${GIT_CONFIG_GLOBAL-unset}"; } >> "${capture}"`,
        ...(fail
          ? ["exit 2"]
          : [
              'case "$*" in',
              `  *"rev-parse --show-toplevel"*) printf '%s\\n' "${topLevel}";;`,
              `  *"rev-parse HEAD"*) printf '%s\\n' "${SOURCE_COMMIT}";;`,
              '  *"status --porcelain --untracked-files=all"*) ;;',
              "  *) exit 2;;",
              "esac",
            ]),
        "",
      ].join("\n"),
    );
    await chmod(fakeGit, 0o755);
  };
  try {
    await writeFakeGit(sourceRoot);
    Bun.env.PATH = `${bin}:${previous.PATH ?? ""}`;
    Bun.env.HOME = directory;
    Bun.env.TMPDIR = directory;
    Bun.env.GIT_DIR = join(directory, "hostile.git");
    Bun.env.GIT_WORK_TREE = join(directory, "hostile-work-tree");
    Bun.env.GIT_CONFIG_GLOBAL = join(directory, ".gitconfig");

    await expect(
      inspectAccountsD1SourceCheckout({ sourceRoot }),
    ).resolves.toEqual({ commit: SOURCE_COMMIT, status: "" });
    const captured = await readFile(capture, "utf8");
    expect(captured).toContain("-c core.hooksPath=/dev/null");
    expect(captured).toContain("-c core.fsmonitor=false");
    expect(captured).toContain("-c core.attributesFile=/dev/null");
    expect(captured).toContain("GIT_DIR=unset");
    expect(captured).toContain("GIT_WORK_TREE=unset");
    expect(captured).toContain("GIT_CONFIG_NOSYSTEM=1");
    expect(captured).toContain("GIT_CONFIG_GLOBAL=/dev/null");

    await writeFakeGit(directory);
    await expect(
      inspectAccountsD1SourceCheckout({ sourceRoot }),
    ).rejects.toThrow("source_checkout_inspection_failed");
    await expect(
      inspectAccountsD1SourceCheckout({ sourceRoot: directory }),
    ).rejects.toThrow("source_checkout_inspection_failed");

    await writeFakeGit(sourceRoot, true);
    await expect(
      inspectAccountsD1SourceCheckout({ sourceRoot }),
    ).rejects.toThrow("source_checkout_inspection_failed");

    const fsmonitorHook = join(directory, "hostile-fsmonitor.sh");
    const fsmonitorMarker = join(directory, "hostile-fsmonitor-ran");
    await writeFile(
      fsmonitorHook,
      `#!/bin/sh\ntouch ${JSON.stringify(fsmonitorMarker)}\nprintf '\\n'\n`,
    );
    await chmod(fsmonitorHook, 0o755);
    await writeFile(
      join(directory, ".gitconfig"),
      `[core]\n\tfsmonitor = ${fsmonitorHook}\n`,
    );
    Bun.env.PATH = previous.PATH;
    const actual = await inspectAccountsD1SourceCheckout({ sourceRoot });
    expect(actual.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(await Bun.file(fsmonitorMarker).exists()).toBe(false);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete Bun.env[name];
      else Bun.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrate-d1 rejects retired Wrangler target authority", async () => {
  for (const retired of [
    ["--remote"],
    ["--env", "staging"],
    ["--wrangler-config", "operator.toml"],
  ]) {
    const stderr: string[] = [];
    const code = await runAccountsMigrateD1(
      [
        "plan",
        ...retired,
        "--environment",
        "staging",
        "--account-id",
        "account_123",
        "--database-id",
        "database_456",
        "--source-commit",
        SOURCE_COMMIT,
      ],
      { stdout: () => {}, stderr: (line) => stderr.push(line) },
    );
    expect(code).toBe(2);
    expect(stderr).toEqual([
      "--remote, --env, and --wrangler-config are retired; use explicit REST target options",
    ]);
  }
});

test("migrate-d1 backup-status writes raw bookmark evidence only to a new 0600 file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-accounts-d1-backup-"));
  const out = join(directory, "bookmark-evidence.json");
  const stdout: string[] = [];
  let reads = 0;
  try {
    const code = await runAccountsMigrateD1(
      [
        "backup-status",
        "--environment",
        "production",
        "--account-id",
        "account_123",
        "--database-id",
        "database_456",
        "--source-commit",
        SOURCE_COMMIT,
        "--out",
        out,
      ],
      { stdout: (line) => stdout.push(line), stderr: () => {} },
      {
        ...CLEAN_SOURCE_CHECKOUT,
        apiToken: "token_must_not_appear",
        now: () => Date.parse("2026-08-26T00:00:00.000Z"),
        async readBookmark() {
          reads += 1;
          return "opaque-bookmark-private";
        },
      },
    );
    expect(code).toBe(0);
    expect(reads).toBe(1);
    expect((await stat(out)).mode & 0o777).toBe(0o600);

    const evidence = JSON.parse(await readFile(out, "utf8"));
    expect(evidence).toMatchObject({
      kind: "takosumi.accounts.d1-backup-evidence@v1",
      sourceCommit: SOURCE_COMMIT,
      environment: "production",
      bookmark: "opaque-bookmark-private",
      capturedAt: "2026-08-26T00:00:00.000Z",
    });
    expect(evidence).not.toHaveProperty("accountId");
    expect(evidence).not.toHaveProperty("databaseId");

    const transcript = stdout.join("\n");
    expect(JSON.parse(transcript)).toMatchObject({
      mode: "backup-status",
      status: "captured",
      backupEvidenceDigest: evidence.backupEvidenceDigest,
      privateFileMode: "0600",
    });
    expect(transcript).not.toContain("opaque-bookmark-private");
    expect(transcript).not.toContain("account_123");
    expect(transcript).not.toContain("database_456");
    expect(transcript).not.toContain("token_must_not_appear");
    expect(transcript).not.toContain(out);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owner-private backup evidence rejects unsafe paths and publishes atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-accounts-private-"));
  const privateDirectory = join(root, "private");
  const linkedDirectory = join(root, "linked");
  const repoRoot = resolve(import.meta.dir, "../../..");
  const insideRepoDirectory = join(repoRoot, ".accounts-private-evidence-test");
  await chmod(root, 0o700);
  await mkdir(privateDirectory, { mode: 0o700 });
  await symlink(privateDirectory, linkedDirectory);
  await mkdir(insideRepoDirectory, { mode: 0o700 });
  try {
    const sourceRoots = [repoRoot];
    await expect(
      writeNewOwnerPrivateEvidenceJson(
        join(linkedDirectory, "parent-symlink.json"),
        { private: "must-not-appear" },
        { sourceRoots },
      ),
    ).rejects.toThrow("owner_private_evidence_path_invalid");
    await expect(
      writeNewOwnerPrivateEvidenceJson(
        join(insideRepoDirectory, "inside-repo.json"),
        { private: "must-not-appear" },
        { sourceRoots },
      ),
    ).rejects.toThrow("owner_private_evidence_path_invalid");

    const existing = join(privateDirectory, "existing.json");
    await Bun.write(existing, "existing");
    await chmod(existing, 0o600);
    await expect(
      writeNewOwnerPrivateEvidenceJson(
        existing,
        { private: "must-not-appear" },
        { sourceRoots },
      ),
    ).rejects.toThrow("owner_private_evidence_target_exists");

    const symlinkTarget = join(privateDirectory, "target-symlink.json");
    await symlink(existing, symlinkTarget);
    await expect(
      writeNewOwnerPrivateEvidenceJson(
        symlinkTarget,
        { private: "must-not-appear" },
        { sourceRoots },
      ),
    ).rejects.toThrow("owner_private_evidence_target_exists");

    const wrongUidTarget = join(privateDirectory, "wrong-uid.json");
    await expect(
      writeNewOwnerPrivateEvidenceJson(
        wrongUidTarget,
        { private: "must-not-appear" },
        {
          sourceRoots,
          runtime: {
            ...nodeOwnerPrivateEvidenceRuntime,
            async lstat(path) {
              const info = await nodeOwnerPrivateEvidenceRuntime.lstat(path);
              if (resolve(String(path)) !== resolve(privateDirectory)) {
                return info;
              }
              return {
                ...info,
                uid: info.uid + 1,
                isDirectory: () => info.isDirectory(),
                isFile: () => info.isFile(),
                isSymbolicLink: () => info.isSymbolicLink(),
              };
            },
          },
        },
      ),
    ).rejects.toThrow("owner_private_evidence_parent_invalid");

    const collisionTarget = join(privateDirectory, "collision.json");
    await expect(
      writeNewOwnerPrivateEvidenceJson(
        collisionTarget,
        { private: "must-not-appear" },
        {
          sourceRoots,
          runtime: {
            ...nodeOwnerPrivateEvidenceRuntime,
            async link(temporary, target) {
              const collision = await open(target, "wx", 0o600);
              await collision.close();
              return await nodeOwnerPrivateEvidenceRuntime.link(
                temporary,
                target,
              );
            },
          },
        },
      ),
    ).rejects.toThrow("owner_private_evidence_target_exists");
    expect(await readFile(collisionTarget, "utf8")).toBe("");
    expect(
      (await readdir(privateDirectory)).some((name) => name.endsWith(".tmp")),
    ).toBe(false);

    const published = join(privateDirectory, "published.json");
    await writeNewOwnerPrivateEvidenceJson(
      published,
      { status: "private" },
      { sourceRoots },
    );
    const publishedInfo = await lstat(published);
    expect(publishedInfo.isFile()).toBe(true);
    expect(publishedInfo.isSymbolicLink()).toBe(false);
    expect(publishedInfo.mode & 0o777).toBe(0o600);
    expect(publishedInfo.nlink).toBe(1);
    expect((await lstat(privateDirectory)).mode & 0o777).toBe(0o700);
  } finally {
    await rm(insideRepoDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("migrate-d1 owner CLI dispatches apply, status, and verify without exposing values", async () => {
  const catalog = await loadD1AccountsMigrationCatalog();
  const database = await databaseAtHead(3);
  const plan = await productionPlan();
  let batchCalls = 0;
  const observed: D1AccountsMigrationDatabase = {
    prepare: (sql) => database.prepare(sql),
    batch(statements) {
      batchCalls += 1;
      return database.batch(statements);
    },
  };
  const base = [
    "--environment",
    "production",
    "--account-id",
    "account_123",
    "--database-id",
    "database_456",
    "--source-commit",
    SOURCE_COMMIT,
  ];
  const applyOutput: string[] = [];
  const applyCode = await runAccountsMigrateD1(
    [
      "apply",
      ...base,
      "--backup-evidence-digest",
      plan.backupEvidenceDigest!,
      "--confirm-source-digest",
      plan.sourceDigest,
      "--confirm-catalog-digest",
      plan.catalogDigest,
      "--confirm-target-digest",
      plan.targetDigest,
      "--confirm-configuration-digest",
      plan.configurationDigest,
    ],
    { stdout: (line) => applyOutput.push(line), stderr: () => {} },
    {
      ...CLEAN_SOURCE_CHECKOUT,
      apiToken: "token_must_not_appear",
      catalog,
      createDatabase: () => observed,
      now: () => 2_000,
    },
  );
  expect(applyCode).toBe(0);
  expect(JSON.parse(applyOutput.join("\n"))).toMatchObject({
    mode: "apply",
    status: "applied",
    applied: [4],
  });
  expect(batchCalls).toBe(1);

  for (const mode of ["status", "verify"] as const) {
    const output: string[] = [];
    const code = await runAccountsMigrateD1(
      [mode, ...base],
      { stdout: (line) => output.push(line), stderr: () => {} },
      {
        ...CLEAN_SOURCE_CHECKOUT,
        apiToken: "token_must_not_appear",
        catalog,
        createDatabase: () => observed,
      },
    );
    expect(code).toBe(0);
    const transcript = output.join("\n");
    expect(JSON.parse(transcript)).toMatchObject({ mode, status: "verified" });
    expect(transcript).not.toContain("account_123");
    expect(transcript).not.toContain("database_456");
    expect(transcript).not.toContain("token_must_not_appear");
  }
  expect(batchCalls).toBe(1);
});

test("Accounts D1 status and verify are strictly read-only", async () => {
  const catalog = await loadD1AccountsMigrationCatalog();
  const plan = await buildD1AccountsMigrationPlan({
    sourceCommit: SOURCE_COMMIT,
    environment: "staging",
    accountId: "account_123",
    databaseId: "database_456",
  });
  const database = await databaseAtHead(3);
  const statements: string[] = [];
  let batchCalls = 0;
  const observed: D1AccountsMigrationDatabase = {
    prepare(sql) {
      statements.push(sql);
      return database.prepare(sql);
    },
    batch(batch) {
      batchCalls += 1;
      return database.batch(batch);
    },
  };

  const status = await statusPlannedD1AccountsMigrations({
    database: observed,
    catalog,
    plan,
  });
  expect(status.status).toBe("pending");
  expect(status.skipped).toEqual([0, 1, 2, 3]);

  const failedVerify = await verifyPlannedD1AccountsMigrations({
    database: observed,
    catalog,
    plan,
  });
  expect(failedVerify.status).toBe("invalid");
  expect(failedVerify.failureCode).toBe("exact_v4_required");
  expect(batchCalls).toBe(0);
  expect(
    statements.every((sql) => /^(?:SELECT|PRAGMA)\b/iu.test(sql.trim())),
  ).toBe(true);

  const v4Database = await databaseAtHead(4);
  const verified = await verifyPlannedD1AccountsMigrations({
    database: v4Database,
    catalog,
    plan,
  });
  expect(verified.status).toBe("verified");
  expect(verified.failureCode).toBeUndefined();

  await v4Database
    .prepare("DROP INDEX takosumi_accounts_indexes_lookup")
    .run();
  await v4Database
    .prepare(
      "CREATE INDEX takosumi_accounts_indexes_lookup ON takosumi_accounts_indexes (document_key)",
    )
    .run();
  const structurallyInvalid = await verifyPlannedD1AccountsMigrations({
    database: v4Database,
    catalog,
    plan,
  });
  expect(structurallyInvalid.status).toBe("invalid");
  expect(structurallyInvalid.issues).toContain("schema_closure_mismatch");
});

test("Accounts D1 lost acknowledgement reconciles only an exact committed receipt", async () => {
  const catalog = await loadD1AccountsMigrationCatalog();
  const plan = await productionPlan();
  const backing = await databaseAtHead(3);
  const lostAck: D1AccountsMigrationDatabase = {
    prepare: (sql) => backing.prepare(sql),
    async batch(statements) {
      await backing.batch(statements);
      throw new Error("simulated_lost_ack");
    },
  };

  const report = await applyWithConfirmations(lostAck, catalog, plan);
  expect(report.applied).toEqual([]);
  expect(report.lostAcknowledgementReconciled).toEqual([4]);

  const absent = await databaseAtHead(3);
  const notCommitted: D1AccountsMigrationDatabase = {
    prepare: (sql) => absent.prepare(sql),
    batch: () => Promise.reject(new Error("request_failed_before_commit")),
  };
  await expect(
    applyWithConfirmations(notCommitted, catalog, plan),
  ).rejects.toThrow("migration_batch_not_committed_retry_required");

  const partial = await databaseAtHead(3);
  const partiallyMutated: D1AccountsMigrationDatabase = {
    prepare: (sql) => partial.prepare(sql),
    async batch() {
      await partial
        .prepare(
          "ALTER TABLE takosumi_accounts_schema_migrations ADD COLUMN checksum TEXT",
        )
        .run();
      throw new Error("simulated_non_atomic_transport");
    },
  };
  await expect(
    applyWithConfirmations(partiallyMutated, catalog, plan),
  ).rejects.toThrow("migration_state_indeterminate");

  const unreadableAfterCommit = await databaseAtHead(3);
  let committed = false;
  const readFailure: D1AccountsMigrationDatabase = {
    prepare(sql) {
      if (!committed) return unreadableAfterCommit.prepare(sql);
      return {
        bind: () => readFailure.prepare(sql),
        run: () => Promise.reject(new Error("post_commit_read_failed")),
        first: () => Promise.reject(new Error("post_commit_read_failed")),
        all: () => Promise.reject(new Error("post_commit_read_failed")),
      };
    },
    async batch(statements) {
      const results = await unreadableAfterCommit.batch(statements);
      committed = true;
      return results;
    },
  };
  await expect(
    applyWithConfirmations(readFailure, catalog, plan),
  ).rejects.toThrow("migration_state_indeterminate");
});

test("same-catalog runner adopts the winner while a conflicting catalog fails closed", async () => {
  const catalog = await loadD1AccountsMigrationCatalog();
  const plan = await productionPlan();
  const v4 = catalog.migrations[4];
  if (!v4) throw new Error("Accounts D1 v4 is missing");

  const sameCatalogBacking = await databaseAtHead(3);
  let winnerCommitted = false;
  const sameCatalogLoser: D1AccountsMigrationDatabase = {
    prepare: (sql) => sameCatalogBacking.prepare(sql),
    async batch(statements) {
      if (!winnerCommitted) {
        winnerCommitted = true;
        await applyD1AccountsMigrationBatch(sameCatalogBacking, v4, 2_000);
      }
      return await sameCatalogBacking.batch(statements);
    },
  };
  const adopted = await applyWithConfirmations(
    sameCatalogLoser,
    catalog,
    plan,
  );
  expect(adopted.applied).toEqual([]);
  expect(adopted.lostAcknowledgementReconciled).toEqual([4]);

  const conflictingV4 = {
    ...v4,
    checksum: `sha256:${"c".repeat(64)}`,
  };
  const conflictingCatalog = {
    ...catalog,
    digest: `sha256:${"d".repeat(64)}`,
    migrations: [...catalog.migrations.slice(0, 4), conflictingV4],
  };
  const conflictingPlanBody = {
    ...plan,
    catalogDigest: conflictingCatalog.digest,
  };
  const conflictingPlan = {
    ...conflictingPlanBody,
    configurationDigest: await digestD1AccountsValue({
      sourceDigest: conflictingPlanBody.sourceDigest,
      catalogDigest: conflictingPlanBody.catalogDigest,
      targetDigest: conflictingPlanBody.targetDigest,
      migrationPolicyDigest: conflictingPlanBody.migrationPolicyDigest,
      backupEvidenceDigest: conflictingPlanBody.backupEvidenceDigest,
    }),
  };
  const conflictBacking = await databaseAtHead(3);
  let canonicalWinnerCommitted = false;
  const conflictingLoser: D1AccountsMigrationDatabase = {
    prepare: (sql) => conflictBacking.prepare(sql),
    async batch(statements) {
      if (!canonicalWinnerCommitted) {
        canonicalWinnerCommitted = true;
        await applyD1AccountsMigrationBatch(conflictBacking, v4, 2_000);
      }
      return await conflictBacking.batch(statements);
    },
  };
  await expect(
    applyPlannedD1AccountsMigrations({
      database: conflictingLoser,
      catalog: conflictingCatalog,
      plan: conflictingPlan,
      confirmSourceDigest: conflictingPlan.sourceDigest,
      confirmCatalogDigest: conflictingPlan.catalogDigest,
      confirmTargetDigest: conflictingPlan.targetDigest,
      confirmConfigurationDigest: conflictingPlan.configurationDigest,
      now: () => 2_001,
    }),
  ).rejects.toThrow("migration_state_indeterminate");
});

async function databaseAtHead(head: number): Promise<SqliteFakeD1> {
  const catalog = await loadD1AccountsMigrationCatalog();
  const database = new SqliteFakeD1();
  for (const migration of catalog.migrations.slice(0, head + 1)) {
    await applyD1AccountsMigrationBatch(database, migration, 1_000 + migration.version);
  }
  return database;
}

function productionPlan() {
  return buildD1AccountsMigrationPlan({
    sourceCommit: SOURCE_COMMIT,
    environment: "production",
    accountId: "account_123",
    databaseId: "database_456",
    backupEvidenceDigest: `sha256:${"b".repeat(64)}`,
  });
}

function applyWithConfirmations(
  database: D1AccountsMigrationDatabase,
  catalog: Awaited<ReturnType<typeof loadD1AccountsMigrationCatalog>>,
  plan: Awaited<ReturnType<typeof productionPlan>>,
) {
  return applyPlannedD1AccountsMigrations({
    database,
    catalog,
    plan,
    confirmSourceDigest: plan.sourceDigest,
    confirmCatalogDigest: plan.catalogDigest,
    confirmTargetDigest: plan.targetDigest,
    confirmConfigurationDigest: plan.configurationDigest,
    now: () => 2_000,
  });
}
