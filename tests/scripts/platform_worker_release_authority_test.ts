import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertPlatformRestoreCandidate,
  assertServingVersion,
  appendPlatformMutationFence,
  appendPlatformRestoreFence,
  buildDryRunSeal,
  createPlatformDryRunConfig,
  createPlatformUploadCustody,
  dashboardAssetTreeSeal,
  parseDeployedVersion,
  platformMutationFailureState,
  platformMutationAction,
  platformMutationCheckpointPath,
  platformRestoreConfigProjection,
  platformRestoreFailureState,
  platformRestoreCheckpointPath,
  platformRestoreLockPath,
  platformWorkerRestoreVersionArguments,
  platformSealedConfigProjection,
  platformReleaseSourcePinPath,
  parsePlatformReleaseSourcePin,
  assertPinnedSourceRoot,
  sameGitRemote,
  platformWorkerDeployArguments,
  readPlatformMutationFence,
  readPlatformRestoreFence,
  selectRecoveredVersion,
} from "../../scripts/platform-worker-release.ts";

const roots: string[] = [];
const PREVIOUS = "11111111-1111-4111-8111-111111111111";
const DEPLOYED = "22222222-2222-4222-8222-222222222222";
const CONCURRENT = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function assets() {
  const root = mkdtempSync(join(tmpdir(), "takosumi-platform-assets-"));
  roots.push(root);
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "index-v1");
  writeFileSync(join(root, "assets", "chunk.js"), "chunk-v1");
  return root;
}

test("complete physical asset-tree seal detects index, chunk, add, and remove drift", () => {
  const root = assets();
  const initial = dashboardAssetTreeSeal(root);
  expect(initial.entries.map((entry) => entry.path)).toEqual([
    "assets/chunk.js",
    "index.html",
  ]);

  writeFileSync(join(root, "index.html"), "index-v2");
  expect(dashboardAssetTreeSeal(root).digest).not.toBe(initial.digest);
  writeFileSync(join(root, "index.html"), "index-v1");
  writeFileSync(join(root, "assets", "chunk.js"), "chunk-v2");
  expect(dashboardAssetTreeSeal(root).digest).not.toBe(initial.digest);
  writeFileSync(join(root, "assets", "chunk.js"), "chunk-v1");
  writeFileSync(join(root, "added.css"), "added");
  expect(dashboardAssetTreeSeal(root).digest).not.toBe(initial.digest);
  rmSync(join(root, "added.css"));
  rmSync(join(root, "assets", "chunk.js"));
  expect(dashboardAssetTreeSeal(root).digest).not.toBe(initial.digest);
});

test("asset-tree seal refuses symlinks and non-files", () => {
  const root = assets();
  symlinkSync(join(root, "index.html"), join(root, "linked.html"));
  expect(() => dashboardAssetTreeSeal(root)).toThrow(
    "platform_worker_release_asset_tree_invalid",
  );
});

test("asset-tree seal refuses hardlinks even when their bytes match", () => {
  const root = assets();
  linkSync(join(root, "index.html"), join(root, "hardlinked.html"));
  expect(() => dashboardAssetTreeSeal(root)).toThrow(
    "platform_worker_release_asset_tree_invalid",
  );
});

test("sealed deploy config injects the closure's source paths into an identity-only config", () => {
  // The realized config carries identity, never a path into a source tree.
  const original = [
    'name = "takosumi-staging"',
    'compatibility_date = "2026-08-27"',
    "[assets]",
    'binding = "ASSETS"',
    "[[containers]]",
    'class_name = "OpenTofuRunnerObject"',
    'image = "registry.cloudflare.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/takosumi-runner@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
    "",
  ].join("\n");
  expect(
    platformSealedConfigProjection(
      original,
      "/operator/wrangler.toml",
      "/release/closure/wrangler.toml",
      "/release/closure/source/deploy/platform/entry-worker.ts",
      "/release/closure/dashboard",
    ),
  ).toBe(
    original
      .replace(
        'name = "takosumi-staging"',
        'name = "takosumi-staging"\nmain = "source/deploy/platform/entry-worker.ts"',
      )
      .replace("[assets]", '[assets]\ndirectory = "dashboard"'),
  );

  // A config that already states a source path is refused, not silently
  // overwritten: it means the config changed after it was checked.
  expect(() =>
    platformSealedConfigProjection(
      original.replace(
        'name = "takosumi-staging"',
        'name = "takosumi-staging"\nmain = "../checkout/deploy/platform/entry-worker.ts"',
      ),
      "/operator/wrangler.toml",
      "/release/closure/wrangler.toml",
      "/release/closure/source/deploy/platform/entry-worker.ts",
      "/release/closure/dashboard",
    ),
  ).toThrow("platform_worker_release_sealed_config_invalid");
});

test("platform upload consumes a fresh exact sealed custody copy, not the retained plan tree", () => {
  const root = mkdtempSync(join(tmpdir(), "takosumi-platform-closure-"));
  roots.push(root);
  const closure = join(root, "closure");
  mkdirSync(join(closure, "dry-run"), { recursive: true });
  mkdirSync(join(closure, "dashboard"));
  mkdirSync(join(closure, "source"));
  writeFileSync(join(closure, "wrangler.toml"), 'name = "takosumi-staging"\n');
  writeFileSync(join(closure, "dry-run", "index.js"), "export default {};\n");
  writeFileSync(join(closure, "dashboard", "index.html"), "dashboard-v1");
  writeFileSync(join(closure, "source", "entry.ts"), "export default {};\n");
  const expected = dashboardAssetTreeSeal(closure);
  const custody = createPlatformUploadCustody(
    closure,
    expected,
    join(closure, "dry-run", "index.js"),
    root,
  );
  expect(custody.configPath).not.toBe(join(closure, "wrangler.toml"));
  expect(custody.uploadEntrypointPath).not.toBe(
    join(closure, "dry-run", "index.js"),
  );
  expect(dashboardAssetTreeSeal(custody.closurePath)).toEqual(expected);

  writeFileSync(join(closure, "dry-run", "index.js"), "raced source bytes\n");
  expect(dashboardAssetTreeSeal(custody.closurePath)).toEqual(expected);
  expect(() => custody.dispose()).not.toThrow();
});

test("plan dry-run invokes Wrangler from the exact candidate worktree root", async () => {
  const root = mkdtempSync(join(tmpdir(), "takosumi-platform-dry-run-root-"));
  roots.push(root);
  const config = join(root, "wrangler.toml");
  const output = join(root, "dry-run");
  mkdirSync(output);
  writeFileSync(config, 'name = "takosumi-staging"\n', { mode: 0o600 });
  const calls: Array<{ argv: readonly string[]; cwd: string | undefined }> = [];
  const buildRoot = resolve(import.meta.dir, "../..");

  const seal = await buildDryRunSeal(
    config,
    output,
    true,
    async (argv, _stdin, cwd) => {
      calls.push({ argv: [...argv], cwd });
      writeFileSync(join(output, "worker.js"), "export default {};\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    buildRoot,
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]?.cwd).toBe(buildRoot);
  expect(calls[0]?.argv.slice(1)).toEqual([
    "deploy",
    "--dry-run",
    "--outdir",
    output,
    "--containers-rollout",
    "immediate",
    "--strict",
    "--config",
    config,
  ]);
  expect(seal.entries.map((entry) => entry.path)).toEqual(["worker.js"]);
});

test("transient restore dry-run config stays global and cleans up", () => {
  const originalConfigPath = resolve(import.meta.dir, "../../deploy/platform/wrangler.toml");
  const transient = createPlatformDryRunConfig(
    ['name = "takosumi"', "[assets]", 'binding = "ASSETS"', ""].join("\n"),
    originalConfigPath,
  );
  try {
    expect(relative(resolve(import.meta.dir, "../.."), transient.path)).toMatch(
      /^\.\./u,
    );
    expect(readFileSync(transient.path, "utf8")).toContain(
      `main = ${JSON.stringify(resolve(import.meta.dir, "../../deploy/platform/entry-worker.ts"))}`,
    );
    expect(readFileSync(transient.path, "utf8")).toContain(
      `directory = ${JSON.stringify(resolve(import.meta.dir, "../../dashboard/dist"))}`,
    );
  } finally {
    transient.dispose();
  }
  expect(existsSync(transient.path)).toBeFalse();
});

test("asset-tree seal fails closed when a file is swapped after no-follow open", () => {
  const root = assets();
  let swapped = false;
  expect(() =>
    dashboardAssetTreeSeal(root, {
      afterFileOpen(path) {
        if (swapped || !path.endsWith("index.html")) return;
        swapped = true;
        renameSync(path, `${path}.opened`);
        writeFileSync(path, "raced-replacement");
      },
    }),
  ).toThrow("platform_worker_release_asset_tree_invalid");
  expect(swapped).toBeTrue();
});

test("deploy output must emit exactly one Worker Version UUID", () => {
  expect(parseDeployedVersion(`Current Version ID: ${DEPLOYED}\n`)).toBe(
    DEPLOYED,
  );
  expect(() => parseDeployedVersion("Uploaded takosumi\n")).toThrow(
    "platform_worker_release_emitted_version_invalid",
  );
  expect(() =>
    parseDeployedVersion(
      `Current Version ID: ${DEPLOYED}\nCurrent Version ID: ${DEPLOYED}\n`,
    ),
  ).toThrow("platform_worker_release_emitted_version_invalid");
});

test("the sole platform mutation is tagged strict deploy with immediate Container rollout", () => {
  expect(
    platformWorkerDeployArguments(
      "/private/wrangler.toml",
      `tks-stg-${"a".repeat(48)}`,
      `takosumi-platform-release sha256:${"b".repeat(64)}`,
    ).slice(1),
  ).toEqual([
    "deploy",
    "--config",
    "/private/wrangler.toml",
    "--tag",
    `tks-stg-${"a".repeat(48)}`,
    "--message",
    `takosumi-platform-release sha256:${"b".repeat(64)}`,
    "--containers-rollout",
    "immediate",
    "--strict",
  ]);
  expect(
    platformWorkerDeployArguments(
      "/release/closure/wrangler.toml",
      `tks-stg-${"a".repeat(48)}`,
      `takosumi-platform-release sha256:${"b".repeat(64)}`,
      "/release/closure/dry-run/index.js",
    ).slice(1),
  ).toEqual([
    "deploy",
    "/release/closure/dry-run/index.js",
    "--no-bundle",
    "--config",
    "/release/closure/wrangler.toml",
    "--tag",
    `tks-stg-${"a".repeat(48)}`,
    "--message",
    `takosumi-platform-release sha256:${"b".repeat(64)}`,
    "--containers-rollout",
    "immediate",
    "--strict",
  ]);
});

test("serving deployment must be the emitted UUID alone at 100 percent", () => {
  const status = (versions: readonly unknown[]) =>
    JSON.stringify({ id: "deployment", versions });
  expect(() =>
    assertServingVersion(
      status([{ version_id: DEPLOYED, percentage: 100 }]),
      DEPLOYED,
      PREVIOUS,
    ),
  ).not.toThrow();
  expect(() =>
    assertServingVersion(
      status([{ version_id: CONCURRENT, percentage: 100 }]),
      DEPLOYED,
      PREVIOUS,
    ),
  ).toThrow("platform_worker_release_concurrent_version");
  expect(() =>
    assertServingVersion(
      status([
        { version_id: DEPLOYED, percentage: 50 },
        { version_id: PREVIOUS, percentage: 50 },
      ]),
      DEPLOYED,
      PREVIOUS,
    ),
  ).toThrow("platform_worker_release_serving_version_invalid");
  expect(() =>
    assertServingVersion(
      status([{ version_id: PREVIOUS, percentage: 100 }]),
      DEPLOYED,
      PREVIOUS,
    ),
  ).toThrow("platform_worker_release_predecessor_unchanged");
});

test("lost acknowledgement recovery requires one uniquely tagged post-plan Version", () => {
  const version = (id: string) => ({
    id,
    metadata: { created_on: "2026-08-27T12:01:00Z" },
    annotations: { "workers/tag": "platform-release-proof" },
  });
  expect(
    selectRecoveredVersion(
      JSON.stringify([version(DEPLOYED)]),
      "2026-08-27T12:00:00Z",
      "platform-release-proof",
    ),
  ).toBe(DEPLOYED);
  expect(() =>
    selectRecoveredVersion(
      JSON.stringify([version(DEPLOYED), version(CONCURRENT)]),
      "2026-08-27T12:00:00Z",
      "platform-release-proof",
    ),
  ).toThrow("platform_worker_release_recovery_version_ambiguous");
});

test("any durable mutation fence forces reconciliation across evidence paths", () => {
  expect(platformMutationAction(null)).toBe("deploy");
  expect(platformMutationAction({ outcome: "unknown", versionId: null })).toBe(
    "reconcile",
  );
  expect(
    platformMutationAction({ outcome: "accepted", versionId: DEPLOYED }),
  ).toBe("reconcile");
});

test("plan-derived external fsynced checkpoint is invariant across copied plans and alternate evidence paths", () => {
  const root = mkdtempSync(join(tmpdir(), "takosumi-platform-checkpoint-"));
  roots.push(root);
  const plan = join(root, "plan.json");
  const copiedPlan = join(root, "copied-plan.json");
  const config = join(root, "wrangler.toml");
  writeFileSync(config, "name = \"takosumi-staging\"\n", { mode: 0o600 });
  const checkpointPath = join(root, "mutation-checkpoint.jsonl");
  const planSource = JSON.stringify({ configPath: config, checkpointPath });
  writeFileSync(plan, planSource, { mode: 0o600 });
  writeFileSync(copiedPlan, planSource, { mode: 0o600 });
  const confirmation = `sha256:${"a".repeat(64)}`;
  const firstEvidence = join(root, "first-evidence.json");
  const alternateEvidence = join(root, "alternate-evidence.json");

  const checkpoint = platformMutationCheckpointPath(plan, confirmation);
  expect(checkpoint).toBe(checkpointPath);
  expect(checkpoint).toBe(platformMutationCheckpointPath(copiedPlan, confirmation));
  expect(firstEvidence).not.toBe(alternateEvidence);
  appendPlatformMutationFence(
    plan,
    confirmation,
    { outcome: "unknown", versionId: null },
    "2026-08-27T12:00:00Z",
  );
  const fence = readPlatformMutationFence(copiedPlan, confirmation);
  expect(fence).toEqual({ outcome: "unknown", versionId: null });
  expect(platformMutationAction(fence)).toBe("reconcile");
  expect(() =>
    appendPlatformMutationFence(
      plan,
      confirmation,
      { outcome: "unknown", versionId: null },
      "2026-08-27T12:00:01Z",
    ),
  ).toThrow();
});

test("malformed or torn mutation checkpoints are post-touch ambiguous, never pre-mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "takosumi-platform-torn-checkpoint-"));
  roots.push(root);
  const plan = join(root, "plan.json");
  const config = join(root, "wrangler.toml");
  const checkpointPath = join(root, "mutation-checkpoint.jsonl");
  writeFileSync(config, 'name = "takosumi-staging"\n', { mode: 0o600 });
  writeFileSync(plan, JSON.stringify({ configPath: config, checkpointPath }), {
    mode: 0o600,
  });
  const confirmation = `sha256:${"a".repeat(64)}`;

  writeFileSync(checkpointPath, '{"kind":', { mode: 0o600 });
  expect(platformMutationFailureState(plan, confirmation)).toEqual({
    mutationOutcome: "unknown",
    failureBoundary: "post-mutation-unknown",
  });

  rmSync(checkpointPath);
  writeFileSync(
    checkpointPath,
    JSON.stringify({
      kind: "takosumi.platform-worker-mutation-checkpoint@v1",
      planConfirmation: confirmation,
      recordedAt: "2026-08-27T12:00:00Z",
      outcome: "unknown",
      versionId: null,
    }),
    { mode: 0o600 },
  );
  expect(platformMutationFailureState(plan, confirmation)).toEqual({
    mutationOutcome: "unknown",
    failureBoundary: "post-mutation-unknown",
  });
});

test("reviewed restore uses one plan-derived staged checkpoint across alternate evidence paths", () => {
  const root = mkdtempSync(join(tmpdir(), "takosumi-platform-restore-checkpoint-"));
  roots.push(root);
  const plan = join(root, "plan.json");
  const copiedPlan = join(root, "copied-plan.json");
  const checkpointPath = join(root, "mutation-checkpoint.jsonl");
  const planSource = JSON.stringify({ checkpointPath });
  writeFileSync(plan, planSource, { mode: 0o600 });
  writeFileSync(copiedPlan, planSource, { mode: 0o600 });
  const confirmation = `sha256:${"a".repeat(64)}`;
  const restoreVersion = "44444444-4444-4444-8444-444444444444";

  expect(platformRestoreCheckpointPath(plan, confirmation)).toBe(
    `${checkpointPath}.restore`,
  );
  appendPlatformRestoreFence(
    plan,
    confirmation,
    "container",
    { outcome: "unknown", versionId: null },
  );
  expect(readPlatformRestoreFence(copiedPlan, confirmation)).toEqual({
    container: { outcome: "unknown", versionId: null },
  });
  expect(() =>
    appendPlatformRestoreFence(
      copiedPlan,
      confirmation,
      "container",
      { outcome: "unknown", versionId: null },
    ),
  ).toThrow("platform_worker_restore_checkpoint_invalid");

  appendPlatformRestoreFence(
    copiedPlan,
    confirmation,
    "container",
    { outcome: "accepted", versionId: restoreVersion },
  );
  appendPlatformRestoreFence(
    plan,
    confirmation,
    "worker",
    { outcome: "unknown", versionId: null },
  );
  appendPlatformRestoreFence(
    copiedPlan,
    confirmation,
    "worker",
    { outcome: "accepted", versionId: PREVIOUS },
  );
  expect(readPlatformRestoreFence(plan, confirmation)).toEqual({
    container: { outcome: "accepted", versionId: restoreVersion },
    worker: { outcome: "accepted", versionId: PREVIOUS },
  });
});

test("restore failure evidence follows the latest durable staged checkpoint", () => {
  const root = mkdtempSync(join(tmpdir(), "takosumi-platform-restore-failure-"));
  roots.push(root);
  const plan = join(root, "plan.json");
  const checkpointPath = join(root, "mutation-checkpoint.jsonl");
  writeFileSync(plan, JSON.stringify({ checkpointPath }), { mode: 0o600 });
  const confirmation = `sha256:${"a".repeat(64)}`;

  expect(platformRestoreFailureState(plan, confirmation)).toEqual({
    mutationOutcome: "not-started",
    failureBoundary: "pre-mutation",
  });

  appendPlatformRestoreFence(
    plan,
    confirmation,
    "container",
    { outcome: "unknown", versionId: null },
  );
  expect(platformRestoreFailureState(plan, confirmation)).toEqual({
    mutationOutcome: "unknown",
    failureBoundary: "post-mutation-unknown",
  });

  appendPlatformRestoreFence(
    plan,
    confirmation,
    "container",
    { outcome: "accepted", versionId: DEPLOYED },
  );
  expect(platformRestoreFailureState(plan, confirmation)).toEqual({
    mutationOutcome: "accepted",
    failureBoundary: "post-mutation-readback",
  });

  appendPlatformRestoreFence(
    plan,
    confirmation,
    "worker",
    { outcome: "unknown", versionId: null },
  );
  expect(platformRestoreFailureState(plan, confirmation)).toEqual({
    mutationOutcome: "unknown",
    failureBoundary: "post-mutation-unknown",
  });

  appendPlatformRestoreFence(
    plan,
    confirmation,
    "worker",
    { outcome: "accepted", versionId: PREVIOUS },
  );
  expect(platformRestoreFailureState(plan, confirmation)).toEqual({
    mutationOutcome: "accepted",
    failureBoundary: "post-mutation-readback",
  });

  writeFileSync(`${checkpointPath}.restore`, '{"kind":', { mode: 0o600 });
  expect(platformRestoreFailureState(plan, confirmation)).toEqual({
    mutationOutcome: "unknown",
    failureBoundary: "post-mutation-unknown",
  });
});

test("restore lock excludes an alternate process before provider mutation", async () => {
  const input = restoreProcessFixture();
  const start = join(input.root, "start");
  const release = join(input.root, "release");
  const attempts = join(input.root, "attempts");
  const blocked = join(input.root, "blocked");
  const providerMutations = join(input.root, "provider-mutations");
  const actor = writeRestoreProcessActor(input.root);

  appendPlatformRestoreFence(
    input.plan,
    input.confirmation,
    "container",
    { outcome: "unknown", versionId: null },
  );
  appendPlatformRestoreFence(
    input.plan,
    input.confirmation,
    "container",
    { outcome: "accepted", versionId: DEPLOYED },
  );

  const children = [input.plan, input.copiedPlan].map((plan) =>
    Bun.spawn(
      [
        process.execPath,
        actor,
        "race",
        plan,
        input.confirmation,
        start,
        release,
        attempts,
        blocked,
        providerMutations,
        join(input.root, "serving"),
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    ),
  );
  writeFileSync(start, "go\n");
  await waitForRestoreProcess(
    () => restoreProcessLineCount(attempts) === 2,
    "both restore actors to reach the acquisition barrier",
  );
  await waitForRestoreProcess(
    () => restoreProcessLineCount(blocked) === 1,
    "the alternate restore actor to observe the active owner",
  );
  writeFileSync(release, "continue\n");

  const exitCodes = await Promise.all(children.map((child) => child.exited));
  expect(exitCodes.sort((left, right) => left - right)).toEqual([0, 73]);
  expect(restoreProcessLineCount(providerMutations)).toBe(1);
  expect(readPlatformRestoreFence(input.plan, input.confirmation)).toEqual({
    container: { outcome: "accepted", versionId: DEPLOYED },
    worker: { outcome: "accepted", versionId: PREVIOUS },
  });
  expect(
    readFileSync(platformRestoreCheckpointPath(input.plan, input.confirmation), "utf8")
      .trim()
      .split("\n"),
  ).toHaveLength(4);
  expect(existsSync(platformRestoreLockPath(input.plan, input.confirmation))).toBeFalse();
});

test("a crashed restore owner is recovered from its canonical checkpoint without duplicate provider mutation", async () => {
  const input = restoreProcessFixture();
  const start = join(input.root, "start");
  const release = join(input.root, "release");
  const attempts = join(input.root, "attempts");
  const blocked = join(input.root, "blocked");
  const providerMutations = join(input.root, "provider-mutations");
  const serving = join(input.root, "serving");
  const actor = writeRestoreProcessActor(input.root);

  appendPlatformRestoreFence(
    input.plan,
    input.confirmation,
    "container",
    { outcome: "unknown", versionId: null },
  );
  appendPlatformRestoreFence(
    input.plan,
    input.confirmation,
    "container",
    { outcome: "accepted", versionId: DEPLOYED },
  );
  writeFileSync(start, "go\n");

  const crashed = Bun.spawn(
    [
      process.execPath,
      actor,
      "crash",
      input.plan,
      input.confirmation,
      start,
      release,
      attempts,
      blocked,
      providerMutations,
      serving,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  expect(await crashed.exited).toBe(86);
  expect(existsSync(platformRestoreLockPath(input.plan, input.confirmation))).toBeTrue();
  expect(readPlatformRestoreFence(input.plan, input.confirmation)).toEqual({
    container: { outcome: "accepted", versionId: DEPLOYED },
    worker: { outcome: "unknown", versionId: null },
  });
  expect(restoreProcessLineCount(providerMutations)).toBe(1);

  const recovered = Bun.spawn(
    [
      process.execPath,
      actor,
      "recover",
      input.copiedPlan,
      input.confirmation,
      start,
      release,
      attempts,
      blocked,
      providerMutations,
      serving,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  expect(await recovered.exited).toBe(0);
  expect(restoreProcessLineCount(providerMutations)).toBe(1);
  expect(readPlatformRestoreFence(input.plan, input.confirmation)).toEqual({
    container: { outcome: "accepted", versionId: DEPLOYED },
    worker: { outcome: "accepted", versionId: PREVIOUS },
  });
  expect(
    readFileSync(platformRestoreCheckpointPath(input.plan, input.confirmation), "utf8")
      .trim()
      .split("\n"),
  ).toHaveLength(4);
  expect(existsSync(platformRestoreLockPath(input.plan, input.confirmation))).toBeFalse();
});

function restoreProcessFixture() {
  const root = mkdtempSync(join(tmpdir(), "takosumi-platform-restore-process-"));
  roots.push(root);
  const plan = join(root, "plan.json");
  const copiedPlan = join(root, "copied-plan.json");
  const checkpointPath = join(root, "mutation-checkpoint.jsonl");
  const confirmation = `sha256:${"a".repeat(64)}`;
  const planSource = JSON.stringify({ checkpointPath });
  writeFileSync(plan, planSource, { mode: 0o600 });
  writeFileSync(copiedPlan, planSource, { mode: 0o600 });
  expect(platformRestoreLockPath(copiedPlan, confirmation)).toBe(
    platformRestoreLockPath(plan, confirmation),
  );
  expect(
    platformRestoreLockPath(plan, `sha256:${"b".repeat(64)}`),
  ).not.toBe(platformRestoreLockPath(plan, confirmation));
  return { root, plan, copiedPlan, confirmation };
}

function writeRestoreProcessActor(root: string): string {
  const actor = join(root, "restore-actor.ts");
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dir, "../../scripts/platform-worker-release.ts"),
  ).href;
  writeFileSync(
    actor,
    `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { appendPlatformRestoreFence, readPlatformRestoreFence, withPlatformRestoreLock } from ${JSON.stringify(moduleUrl)};

const [mode, plan, confirmation, start, release, attempts, blocked, providerMutations, serving] = process.argv.slice(2);
while (!existsSync(start)) await Bun.sleep(5);
appendFileSync(attempts, \`${"${process.pid}"}\\n\`);
try {
  await withPlatformRestoreLock(plan, confirmation, async () => {
    const fence = readPlatformRestoreFence(plan, confirmation);
    if (mode === "race") {
      if (fence.worker === undefined) {
        appendPlatformRestoreFence(plan, confirmation, "worker", { outcome: "unknown", versionId: null });
        appendFileSync(providerMutations, "route\\n");
        while (!existsSync(release)) await Bun.sleep(5);
        appendPlatformRestoreFence(plan, confirmation, "worker", { outcome: "accepted", versionId: ${JSON.stringify(PREVIOUS)} });
      }
      return;
    }
    if (mode === "crash") {
      if (fence.worker !== undefined) throw new Error("unexpected_restore_checkpoint");
      appendPlatformRestoreFence(plan, confirmation, "worker", { outcome: "unknown", versionId: null });
      appendFileSync(providerMutations, "route\\n");
      writeFileSync(serving, ${JSON.stringify(PREVIOUS)});
      process.exit(86);
    }
    if (mode !== "recover" || fence.worker?.outcome !== "unknown") {
      throw new Error("unexpected_restore_recovery_checkpoint");
    }
    if (!existsSync(serving)) appendFileSync(providerMutations, "route\\n");
    appendPlatformRestoreFence(plan, confirmation, "worker", { outcome: "accepted", versionId: ${JSON.stringify(PREVIOUS)} });
  });
} catch (error) {
  if (error instanceof Error && error.message === "platform_worker_restore_locked") {
    appendFileSync(blocked, \`${"${process.pid}"}\\n\`);
    process.exit(73);
  }
  console.error(error);
  process.exit(74);
}
`,
  );
  return actor;
}

async function waitForRestoreProcess(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function restoreProcessLineCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
}

test("restore fences the exact reviewed application before one strict predecessor deploy", () => {
  const root = mkdtempSync(join(tmpdir(), "takosumi-platform-restore-start-"));
  roots.push(root);
  const plan = join(root, "plan.json");
  const checkpointPath = join(root, "mutation-checkpoint.jsonl");
  writeFileSync(plan, JSON.stringify({ checkpointPath }), { mode: 0o600 });
  const confirmation = `sha256:${"a".repeat(64)}`;
  const predecessorImage =
    `registry.cloudflare.com/${"a".repeat(32)}/takosumi-runner@sha256:${"b".repeat(64)}`;
  const forwardImage =
    `registry.cloudflare.com/${"a".repeat(32)}/takosumi-runner@sha256:${"c".repeat(64)}`;
  const predecessor = {
    id: "application-id",
    name: "takosumi-staging-opentofurunnerobject",
    state: "ready",
    image: predecessorImage,
    version: 1,
    hasActiveRollout: false,
    health: { failed: 0, starting: 0, scheduling: 0, errorCount: 0 },
  } as const;
  const interruptedForward = {
    ...predecessor,
    state: "deploying",
    image: forwardImage,
    version: 2,
    hasActiveRollout: true,
    health: { failed: 3, starting: 2, scheduling: 1, errorCount: 4 },
  } as const;

  expect(() =>
    assertPlatformRestoreCandidate(
      interruptedForward,
      predecessor,
      forwardImage,
    ),
  ).not.toThrow();
  expect(() =>
    assertPlatformRestoreCandidate(
      { ...interruptedForward, image: predecessorImage },
      predecessor,
      forwardImage,
    ),
  ).not.toThrow();
  appendPlatformRestoreFence(
    plan,
    confirmation,
    "container",
    { outcome: "unknown", versionId: null },
  );
  expect(readPlatformRestoreFence(plan, confirmation)).toEqual({
    container: { outcome: "unknown", versionId: null },
  });
  const deploys = [
    platformWorkerDeployArguments(
      "/private/restored-wrangler.toml",
      `tks-rst-${"d".repeat(48)}`,
      `takosumi-platform-restore sha256:${"e".repeat(64)}`,
      "/private/restore-dry-run/index.js",
    ).slice(1),
  ];
  expect(deploys).toHaveLength(1);
  expect(deploys[0]).toEqual([
    "deploy",
    "/private/restore-dry-run/index.js",
    "--no-bundle",
    "--config",
    "/private/restored-wrangler.toml",
    "--tag",
    `tks-rst-${"d".repeat(48)}`,
    "--message",
    `takosumi-platform-restore sha256:${"e".repeat(64)}`,
    "--containers-rollout",
    "immediate",
    "--strict",
  ]);

  expect(() =>
    assertPlatformRestoreCandidate(
      { ...interruptedForward, id: "changed-application" },
      predecessor,
      forwardImage,
    ),
  ).toThrow("platform_worker_restore_container_identity_changed");
  expect(() =>
    assertPlatformRestoreCandidate(
      {
        ...interruptedForward,
        image:
          `registry.cloudflare.com/${"a".repeat(32)}/takosumi-runner@sha256:${"f".repeat(64)}`,
      },
      predecessor,
      forwardImage,
    ),
  ).toThrow("platform_worker_restore_container_image_changed");
});

test("reviewed restore projects only the predecessor image and routes the predecessor Version through the owner surface", () => {
  const current = [
    'name = "takosumi-staging"',
    'main = "source/deploy/platform/entry-worker.ts"',
    "[[containers]]",
    'class_name = "OpenTofuRunnerObject"',
    'image = "registry.cloudflare.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/takosumi-runner@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
    "max_instances = 1",
    "",
  ].join("\n");
  const predecessorImage =
    `registry.cloudflare.com/${"a".repeat(32)}/takosumi-runner@sha256:${"c".repeat(64)}`;
  expect(platformRestoreConfigProjection(current, predecessorImage)).toBe(
    current.replace(/sha256:b{64}/u, `sha256:${"c".repeat(64)}`),
  );
  expect(
    platformWorkerDeployArguments(
      "/private/restored-wrangler.toml",
      `tks-rst-${"d".repeat(48)}`,
      `takosumi-platform-restore sha256:${"e".repeat(64)}`,
      "/private/restore-dry-run/index.js",
    ).slice(1),
  ).toEqual([
    "deploy",
    "/private/restore-dry-run/index.js",
    "--no-bundle",
    "--config",
    "/private/restored-wrangler.toml",
    "--tag",
    `tks-rst-${"d".repeat(48)}`,
    "--message",
    `takosumi-platform-restore sha256:${"e".repeat(64)}`,
    "--containers-rollout",
    "immediate",
    "--strict",
  ]);
  expect(() =>
    platformWorkerDeployArguments(
      "/private/restored-wrangler.toml",
      `tks-rst-${"d".repeat(48)}`,
      `takosumi-platform-release sha256:${"e".repeat(64)}`,
    ),
  ).toThrow("platform_worker_release_deploy_identity_invalid");
  expect(
    platformWorkerRestoreVersionArguments(
      "/private/restored-wrangler.toml",
      PREVIOUS,
      "takosumi-platform-restore sha256:proof",
    ).slice(1),
  ).toEqual([
    "versions",
    "deploy",
    `${PREVIOUS}@100%`,
    "--config",
    "/private/restored-wrangler.toml",
    "--message",
    "takosumi-platform-restore sha256:proof",
    "--yes",
  ]);
});

test("the realized config's source pin is an identity, and only an identity", () => {
  expect(platformReleaseSourcePinPath("/operator/platform/wrangler.staging.toml")).toBe(
    "/operator/platform/wrangler.staging.source.json",
  );
  expect(() => platformReleaseSourcePinPath("/operator/platform/wrangler")).toThrow(
    "platform_worker_release_config_invalid",
  );

  const pin = {
    kind: "takosumi.platform-release-source@v1",
    repository: "https://github.com/tako0614/takosumi.git",
    commit: "a".repeat(40),
  };
  expect(parsePlatformReleaseSourcePin(JSON.stringify(pin))).toEqual(pin);

  for (const broken of [
    "{",
    JSON.stringify({ ...pin, kind: "something-else" }),
    JSON.stringify({ ...pin, commit: "not-a-commit" }),
    JSON.stringify({ ...pin, repository: "" }),
    // A path is exactly what a pin must not be able to say.
    JSON.stringify({ ...pin, main: "../../.release/whatever/entry-worker.ts" }),
    JSON.stringify({ kind: pin.kind, commit: pin.commit }),
  ]) {
    expect(() => parsePlatformReleaseSourcePin(broken)).toThrow(
      "platform_worker_release_source_pin_invalid",
    );
  }
});

test("one remote written two ways is one remote", () => {
  expect(
    sameGitRemote(
      "git@github.com:tako0614/takosumi.git",
      "https://github.com/tako0614/takosumi",
    ),
  ).toBeTrue();
  expect(
    sameGitRemote(
      "https://github.com/tako0614/takosumi.git",
      "https://github.com/tako0614/takosumi-hosted.git",
    ),
  ).toBeFalse();
});

test("a checkout that is not the pinned commit refuses and names the way out", () => {
  expect(() =>
    assertPinnedSourceRoot({
      kind: "takosumi.platform-release-source@v1",
      repository: "https://github.com/tako0614/takosumi.git",
      commit: "b".repeat(40),
    }),
  ).toThrow("platform_worker_release_source_pin_mismatch");
  expect(() =>
    assertPinnedSourceRoot({
      kind: "takosumi.platform-release-source@v1",
      repository: "https://github.com/tako0614/some-other-repository.git",
      commit: "b".repeat(40),
    }),
  ).toThrow("materialize-source");
});
