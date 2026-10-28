import { expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PRIVATE_RUN_FILE_REFRESH_CAPABILITY,
  privateRunFileManifestDigest,
} from "../../core/shared/private_run_file_refresh.ts";
import {
  beginRunPrivateRunFileRefreshSession,
  commandContextFromRequest,
  endRunPrivateRunFileRefreshSession,
  openTofuCommandContext,
  prepareProviderCredentialFiles,
} from "../../runner/lib/credentials.ts";
import {
  handleRunnerRequest,
  handleRunnerRequestWithDependencies,
} from "../../runner/lib/http_server.ts";
import { runOpenTofuCommand } from "../../runner/lib/exec.ts";
import { RUN_ROOT } from "../../runner/lib/constants.ts";

const RUN_ID = "plan_private_file_refresh_test";
const OWNER = { kind: "plan" as const, id: RUN_ID };
const ENDPOINT = "http://core.internal/internal/private-run-files/v1";
const SLOT = "worker-state";
const CANCEL_RUN_ID = "plan_private_file_refresh_cancel_test";

function file(grant: string, endpoint = ENDPOINT, slot = SLOT) {
  return { slot, endpoint, grant };
}

function requestWith(files: ReturnType<typeof file>[]) {
  return { privateRunFiles: files };
}

function workspace(root: string) {
  return {
    root,
    sourceRoot: join(root, "source"),
    moduleDir: join(root, "module"),
    planPath: join(root, "tfplan"),
    providerLockfilePath: join(root, "lock.hcl"),
    restoredStatePath: join(root, "state.json"),
    moduleInfoPath: join(root, "module.json"),
    generatedRootDir: join(root, "generated"),
    childModuleDir: join(root, "child"),
    artifactDir: join(root, "artifacts"),
  };
}

async function digest(
  files: ReturnType<typeof file>[],
  runId = RUN_ID,
  owner = OWNER,
) {
  return await privateRunFileManifestDigest({
    owner,
    runnerRunId: runId,
    files,
  });
}

async function putRefresh(
  update: Record<string, unknown>,
  runId = RUN_ID,
) {
  return await handleRunnerRequest(new Request(
    `http://runner/runs/${runId}/private-run-files`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    },
  ));
}

test("private Run file refresh advertises capability and rotates the one trusted descriptor file", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-private-files-"));
  const initial = [file("grant-one-private")];
  const request = requestWith(initial);
  const digestValue = await digest(initial);
  const redactionValues = [initial[0]!.grant];
  let session: object | undefined;
  let prepared: Awaited<ReturnType<typeof prepareProviderCredentialFiles>> | undefined;
  try {
    session = await beginRunPrivateRunFileRefreshSession(
      RUN_ID,
      "plan",
      request,
      undefined,
      redactionValues,
      0,
    );
    const health = await handleRunnerRequest(new Request("http://runner/healthz"));
    expect((await health.json()).capabilities).toContain(PRIVATE_RUN_FILE_REFRESH_CAPABILITY);
    const metadata = await handleRunnerRequest(new Request(
      `http://runner/runs/${RUN_ID}/private-run-files`,
    ));
    expect(await metadata.json()).toEqual({
      owner: OWNER,
      runnerRunId: RUN_ID,
      manifestDigest: digestValue,
      sequence: 0,
    });

    const update = {
      kind: "takosumi.private-run-files.refresh@v1",
      owner: OWNER,
      runnerRunId: RUN_ID,
      manifestDigest: digestValue,
      sequence: 1,
      files: [file("grant-two-private")],
    };
    const staged = await putRefresh(update);
    expect(staged.status).toBe(200);
    expect(await staged.json()).toEqual({ ok: true, status: "updated", sequence: 1 });

    const context = commandContextFromRequest(request, undefined, undefined, RUN_ID);
    prepared = await prepareProviderCredentialFiles(context, workspace(root), RUN_ID);
    const providerContext = openTofuCommandContext(prepared.context);
    const path = providerContext.env.TAKOSUMI_PRIVATE_RUN_FILES_FILE!;
    expect(path).toBe(prepared.context.privateRunFilesFile);
    expect(providerContext.env.TAKOSUMI_PRIVATE_RUN_FILES).toBeUndefined();
    const promoted = JSON.parse(await readFile(path, "utf8"));
    expect(promoted).toEqual({ version: 1, sequence: 1, files: [file("grant-two-private")] });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(path)).nlink).toBe(1);

    const fresh = {
      ...update,
      sequence: 2,
      files: [file("grant-three-private")],
    };
    const response = await putRefresh(fresh);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "updated", sequence: 2 });
    const replay = await putRefresh(fresh);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, status: "updated", sequence: 2 });
    // This is the exact file read by the trusted provider handoff seam.
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      sequence: 2,
      files: [file("grant-three-private")],
    });
    const bin = join(root, "bin");
    await mkdir(bin);
    const tofuPath = join(bin, "tofu");
    await writeFile(tofuPath, "#!/bin/sh\ncat \"$TAKOSUMI_PRIVATE_RUN_FILES_FILE\"\n");
    await chmod(tofuPath, 0o700);
    const tofu = await runOpenTofuCommand(["tofu", "plan"], {
      cwd: root,
      context: {
        ...providerContext,
        env: { ...providerContext.env, PATH: `${bin}:/usr/bin:/bin` },
      },
    });
    expect(tofu.exitCode).toBe(0);
    expect(tofu.stdout).toBe(JSON.stringify({
      version: 1,
      sequence: 2,
      files: [file("grant-three-private")],
    }));
    expect(redactionValues).toContain("grant-three-private");
    expect((await lstat(path)).nlink).toBe(1);

    const changedReplay = await putRefresh({
      ...fresh,
      files: [file("different-grant-same-sequence")],
    });
    expect(changedReplay.status).toBe(409);
    expect(await changedReplay.text()).not.toContain("different-grant-same-sequence");
  } finally {
    if (prepared) await prepared.cleanup();
    await endRunPrivateRunFileRefreshSession(RUN_ID, session);
    await rm(root, { recursive: true, force: true });
  }
});

test("private Run file refresh preserves rotations staged before credential-file preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-private-files-prestage-"));
  const initial = [file("prestage-grant-one")];
  const request = requestWith(initial);
  const digestValue = await digest(initial);
  const redactionValues = [initial[0]!.grant];
  const session = await beginRunPrivateRunFileRefreshSession(
    RUN_ID,
    "plan",
    request,
    undefined,
    redactionValues,
    0,
  );
  let prepared: Awaited<ReturnType<typeof prepareProviderCredentialFiles>> | undefined;
  try {
    const beforePreparation = await putRefresh({
      kind: "takosumi.private-run-files.refresh@v1",
      owner: OWNER,
      runnerRunId: RUN_ID,
      manifestDigest: digestValue,
      sequence: 1,
      files: [file("prestage-grant-two")],
    });
    expect(beforePreparation.status).toBe(200);
    prepared = await prepareProviderCredentialFiles(
      commandContextFromRequest(request, undefined, undefined, RUN_ID),
      workspace(root),
      RUN_ID,
    );
    const path = openTofuCommandContext(prepared.context).env.TAKOSUMI_PRIVATE_RUN_FILES_FILE!;
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      sequence: 1,
      files: [file("prestage-grant-two")],
    });
  } finally {
    if (prepared) await prepared.cleanup();
    await endRunPrivateRunFileRefreshSession(RUN_ID, session);
    await rm(root, { recursive: true, force: true });
  }
});

test("local-http private Run file refresh completes only for the live Plan session while the Plan gate is held", async () => {
  const runId = `plan_private_file_local_http_${crypto.randomUUID().replace(/-/gu, "")}`;
  const initial = [file("local-http-grant-one")];
  const rotated = [file("local-http-grant-two")];
  const fakeBin = await mkdtemp(join(tmpdir(), "takosumi-private-files-tofu-"));
  const marker = join(fakeBin, "plan-entered");
  const release = join(fakeBin, "release-plan");
  const tofuPath = join(fakeBin, "tofu");
  const runRoot = join(RUN_ROOT, runId);
  const moduleDir = join(runRoot, "source", "module");
  const previousPath = Bun.env.PATH;
  let planPromise: Promise<Response> | undefined;
  let planFinished = false;
  try {
    await writeFile(tofuPath, `#!/bin/sh
case "$1" in
  init) exit 0 ;;
  plan)
    : > '${marker}'
    while [ ! -e '${release}' ]; do sleep 0.02; done
    for arg in "$@"; do
      if [ "$previous" = "-out" ]; then printf 'fake-plan' > "$arg"; fi
      previous="$arg"
    done
    exit 0
    ;;
  show) printf '{"format_version":"1.2","resource_changes":[]}' ;;
  output) printf '{}' ;;
  *) exit 2 ;;
esac
`);
    await chmod(tofuPath, 0o700);
    Bun.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    await mkdir(moduleDir, { recursive: true });
    await writeFile(join(moduleDir, "main.tf"), "terraform {}\n");
    const planRequest = requestWith(initial) as Record<string, unknown>;
    Object.assign(planRequest, {
      planRun: {
        id: runId,
        operation: "create",
        source: {
          kind: "git",
          url: "https://example.test/private-file-refresh.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
          modulePath: "module",
        },
      },
    });
    planPromise = handleRunnerRequestWithDependencies(new Request(
      `http://runner/runs/${runId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "plan",
          runId,
          request: planRequest,
        }),
      },
    ), { mutationCustodyMode: "local-http" }).then((response) => {
      planFinished = true;
      return response;
    });

    const deadline = Date.now() + 10_000;
    let active = false;
    while (Date.now() < deadline) {
      if (await Bun.file(marker).exists()) {
        active = true;
        break;
      }
      const metadata = await handleRunnerRequestWithDependencies(new Request(
        `http://runner/runs/${runId}/private-run-files`,
      ), { mutationCustodyMode: "local-http" });
      if (metadata.status === 200) active = true;
      if (planFinished) {
        const response = await planPromise!;
        throw new Error(`local-http Plan ended before tofu start (${response.status}): ${await response.text()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(active).toBe(true);
    expect(await Bun.file(marker).exists()).toBe(true);

    const owner = { kind: "plan" as const, id: runId };
    const update = {
      kind: "takosumi.private-run-files.refresh@v1",
      owner,
      runnerRunId: runId,
      manifestDigest: await privateRunFileManifestDigest({
        owner,
        runnerRunId: runId,
        files: initial,
      }),
      sequence: 1,
      files: rotated,
    };
    const refreshed = await handleRunnerRequestWithDependencies(new Request(
      `http://runner/runs/${runId}/private-run-files`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      },
    ), { mutationCustodyMode: "local-http" });
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toEqual({ ok: true, status: "updated", sequence: 1 });
    expect(await Bun.file(release).exists()).toBe(false);

    await writeFile(release, "release");
    expect((await planPromise).status).toBe(200);

    const afterClose = await handleRunnerRequestWithDependencies(new Request(
      `http://runner/runs/${runId}/private-run-files`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...update, sequence: 2 }),
      },
    ), { mutationCustodyMode: "local-http" });
    expect(afterClose.status).toBe(409);
    expect((await afterClose.text()).includes("local-http-grant-two")).toBe(false);
  } finally {
    await writeFile(release, "release").catch(() => {});
    if (planPromise) await planPromise.catch(() => {});
    if (previousPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = previousPath;
    await rm(runRoot, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("private Run file refresh rejects changed scope, endpoint, ordering, and stale sequence without echoing grants", async () => {
  const initial = [file("identity-grant-one")];
  const digestValue = await digest(initial);
  const redactionValues = [initial[0]!.grant];
  const session = await beginRunPrivateRunFileRefreshSession(
    RUN_ID,
    "plan",
    requestWith(initial),
    undefined,
    redactionValues,
    0,
  );
  const base = {
    kind: "takosumi.private-run-files.refresh@v1",
    owner: OWNER,
    runnerRunId: RUN_ID,
    manifestDigest: digestValue,
    sequence: 1,
  };
  try {
    for (const invalid of [
      { ...base, owner: { kind: "plan", id: "foreign-owner" }, files: [file("secret-owner-grant")] },
      { ...base, manifestDigest: `sha256:${"f".repeat(64)}`, files: [file("secret-manifest-grant")] },
      { ...base, files: [file("secret-slot-grant", ENDPOINT, "other-slot")] },
      { ...base, files: [file("secret-endpoint-grant", "http://other.internal/private/v1")] },
      { ...base, sequence: 0, files: [file("secret-stale-grant")] },
    ]) {
      const response = await putRefresh(invalid);
      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain("secret-");
    }
  } finally {
    await endRunPrivateRunFileRefreshSession(RUN_ID, session);
  }
});

test("private Run file refresh refuses symlink and hardlink descriptor replacement targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-private-files-links-"));
  const outside = join(root, "outside.json");
  const initial = [file("link-grant-one")];
  const request = requestWith(initial);
  const redactionValues = [initial[0]!.grant];
  const session = await beginRunPrivateRunFileRefreshSession(
    RUN_ID,
    "plan",
    request,
    undefined,
    redactionValues,
    0,
  );
  let prepared: Awaited<ReturnType<typeof prepareProviderCredentialFiles>> | undefined;
  try {
    prepared = await prepareProviderCredentialFiles(
      commandContextFromRequest(request, undefined, undefined, RUN_ID),
      workspace(root),
      RUN_ID,
    );
    const path = prepared.context.privateRunFilesFile!;
    await rm(path);
    await symlink(outside, path);
    const symlinkUpdate = await putRefresh({
      kind: "takosumi.private-run-files.refresh@v1",
      owner: OWNER,
      runnerRunId: RUN_ID,
      manifestDigest: await digest(initial),
      sequence: 1,
      files: [file("symlink-attempt-grant")],
    });
    expect(symlinkUpdate.status).toBe(409);
    expect(await readFile(outside).catch(() => undefined)).toBeUndefined();

    await rm(path);
    const foreign = join(dirname(path), "foreign.json");
    await writeFile(foreign, "foreign", { mode: 0o600 });
    await link(foreign, path);
    const hardlinkUpdate = await putRefresh({
      kind: "takosumi.private-run-files.refresh@v1",
      owner: OWNER,
      runnerRunId: RUN_ID,
      manifestDigest: await digest(initial),
      sequence: 1,
      files: [file("hardlink-attempt-grant")],
    });
    expect(hardlinkUpdate.status).toBe(409);
    expect(await readFile(foreign, "utf8")).toBe("foreign");
  } finally {
    if (prepared) await prepared.cleanup();
    await endRunPrivateRunFileRefreshSession(RUN_ID, session);
    await rm(root, { recursive: true, force: true });
  }
});

test("private Run file refresh refuses after cancellation and shreds its promoted descriptor on cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-private-files-cancel-"));
  const initial = [file("cancel-grant-one")];
  const request = requestWith(initial);
  const controller = new AbortController();
  const owner = { kind: "plan" as const, id: CANCEL_RUN_ID };
  const session = await beginRunPrivateRunFileRefreshSession(
    CANCEL_RUN_ID,
    "plan",
    request,
    controller.signal,
    [initial[0]!.grant],
    0,
  );
  let prepared: Awaited<ReturnType<typeof prepareProviderCredentialFiles>> | undefined;
  let path: string | undefined;
  try {
    prepared = await prepareProviderCredentialFiles(
      commandContextFromRequest(request, undefined, controller.signal, CANCEL_RUN_ID),
      workspace(root),
      CANCEL_RUN_ID,
    );
    path = prepared.context.privateRunFilesFile;
    controller.abort();
    const response = await putRefresh({
      kind: "takosumi.private-run-files.refresh@v1",
      owner,
      runnerRunId: CANCEL_RUN_ID,
      manifestDigest: await digest(initial, CANCEL_RUN_ID, owner),
      sequence: 1,
      files: [file("cancel-grant-two")],
    }, CANCEL_RUN_ID);
    expect(response.status).toBe(409);
    expect(await readFile(path!, "utf8")).toContain("cancel-grant-one");
  } finally {
    if (prepared) await prepared.cleanup();
    await endRunPrivateRunFileRefreshSession(CANCEL_RUN_ID, session);
    await rm(root, { recursive: true, force: true });
  }
  await expect(readFile(path!, "utf8")).rejects.toThrow();
  const afterClose = await putRefresh({
    kind: "takosumi.private-run-files.refresh@v1",
    owner,
    runnerRunId: CANCEL_RUN_ID,
    manifestDigest: await digest(initial, CANCEL_RUN_ID, owner),
    sequence: 1,
    files: [file("cancel-grant-three")],
  }, CANCEL_RUN_ID);
  expect(afterClose.status).toBe(409);
});
