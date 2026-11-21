/**
 * Explicit native cadence: provider-free output changes and same-process fresh
 * PGlite/Core/crypto objects from saved files. This is neither an OS restart,
 * real PostgreSQL, genuine identity, nor managed-resource proof. Management
 * ownership comes from the real installer; initial identity/Git remain fixtures.
 */
import { expect, test } from "bun:test";
import {
  captureEncryptedStateNativeOutput,
  writeEncryptedStateNativeDiagnostics,
} from "../../../scripts/check-encrypted-state-native.ts";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactReferenceAllocation } from "../../../core/adapters/storage/artifact-references.ts";
import type { OpenTofuRunner } from "../../../core/domains/deploy-control/mod.ts";
import type { RunRootOwnership } from "../../../runner/lib/run_root_ownership.ts";

if (Bun.env.TAKOSUMI_TEST_ENCRYPTED_UPDATE_CHILD !== "1") {
  test("encrypted update reconstruction runs in one private native root", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "takosumi-encrypted-update-root-"),
    );
    await chmod(root, 0o700);
    await Promise.all(
      ["home", "tmp", "cache"].map((name) =>
        mkdir(join(root, name), { mode: 0o700 }),
      ),
    );
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let completed = false;
    const raw = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] };
    let captures: readonly Promise<string>[] = [];
    try {
      child = Bun.spawn(
        [process.execPath, "--no-env-file", "test", import.meta.path],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: join(root, "home"),
            TMPDIR: join(root, "tmp"),
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "cache"),
            LANG: "C.UTF-8",
            TZ: "UTC",
            CI: "1",
            NO_COLOR: "1",
            CHECKPOINT_DISABLE: "1",
            TF_IN_AUTOMATION: "1",
            TAKOSUMI_OPENTOFU_RUN_ROOT: join(root, "runs"),
            TAKOSUMI_TEST_ENCRYPTED_UPDATE_CHILD: "1",
          },
        },
      );
      timeout = setTimeout(() => {
        timedOut = true;
        child?.kill("SIGKILL");
      }, 30_000);
      captures = [
        captureEncryptedStateNativeOutput(child.stdout, raw.stdout),
        captureEncryptedStateNativeOutput(child.stderr, raw.stderr),
      ];
      const [output, error, code] = await Promise.all([
        captures[0]!,
        captures[1]!,
        child.exited,
      ]);
      const summary = `${output}\n${error}`.match(
        /(\d+) pass\s+(\d+) fail\s+(\d+) expect\(\) calls/u,
      );
      if (
        timedOut ||
        code !== 0 ||
        !summary ||
        Number(summary[1]) !== 1 ||
        Number(summary[2]) !== 0
      ) {
        throw new Error(
          `native encrypted update failed (exit ${code}, timeout ${timedOut}, summary ${summary?.[0] ?? "missing"})`,
        );
      }
      console.log(
        `native encrypted update child: ${summary[1]} pass, ${summary[2]} fail, ${summary[3]} assertions`,
      );
      completed = true;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (child && child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await child?.exited;
      if (completed) await rm(root, { recursive: true, force: true });
      else {
        await Promise.allSettled(captures);
        await writeEncryptedStateNativeDiagnostics(root, raw);
        console.error(
          `native encrypted update fixture and bounded child logs retained: ${root}`,
        );
      }
    }
  }, 35_000);
} else {
  const { InMemoryAccountsStore } =
    await import("../../../accounts/service/src/store.ts");
  const { handleControlRoute } =
    await import("../../../accounts/service/src/control-routes.ts");
  const { ACCOUNT_SESSION_COOKIE_NAME } =
    await import("../../../accounts/service/src/account-session.ts");
  const { sha256Digest } =
    await import("../../../core/adapters/source/digest.ts");
  const { PartitionedSecretBoundaryCrypto } =
    await import("../../../core/adapters/secret-store/memory.ts");
  const { ObjectKeyArtifactReferenceAllocator } =
    await import("../../../core/adapters/storage/artifact-references.ts");
  const { SqlOpenTofuControlStore } =
    await import("../../../core/domains/deploy-control/store_sql.ts");
  const { SqlAppOwnershipStore } =
    await import("../../../core/domains/app-ownership/store.ts");
  const { createTakosumiService } = await import("../../../core/bootstrap.ts");
  const {
    createFileOpenTofuStateArtifactStore,
    createHttpOpenTofuRunner,
    createLocalOpenTofuRunnerProfile,
  } =
    await import("../../../deploy/node-postgres/src/local-opentofu-runner.ts");
  const { handleRunnerRequestWithDependencies } =
    await import("../../../runner/entrypoint.ts");
  const { RUN_ROOT } = await import("../../../runner/lib/constants.ts");
  const { ensureCustodyDirectory } =
    await import("../../../runner/lib/run_completion.ts");
  const { acquireRunRootOwnership } =
    await import("../../../runner/lib/run_root_ownership.ts");
  const { FIXTURE_EXECUTION_EVIDENCE_AUTHORITY } =
    await import("../../helpers/deploy-control/model_fixture.ts");
  const { PGliteSqlClient } =
    await import("../../helpers/deploy-control/pglite_sql_client.ts");

  const testPassphrase = Buffer.from(
    crypto.getRandomValues(new Uint8Array(48)),
  ).toString("hex");
  const newCrypto = () =>
    new PartitionedSecretBoundaryCrypto({ globalPassphrase: testPassphrase });
  const STATE_CRYPTO = newCrypto();

  test("native installed-app management update preserves encrypted files and live access through fresh services", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "takosumi-local-v2-core-"));
    const client = await PGliteSqlClient.create();
    let reopenedClient:
      Awaited<ReturnType<typeof PGliteSqlClient.create>> | undefined;
    const id = crypto.randomUUID().replaceAll("-", "");
    const sourceDir = join(tempDir, "source");
    const archivePath = join(tempDir, "source.tar.zst");
    let runnerServer: ReturnType<typeof Bun.serve> | undefined;
    let runRootOwner: RunRootOwnership | undefined;
    let ackLossProxy: ReturnType<typeof Bun.serve> | undefined;
    try {
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        join(sourceDir, "main.tf"),
        'variable "public_url" {\n type = string\n default = "https://before.example.test"\n}\noutput "launch_url" { value = var.public_url }\n',
      );
      const tar = spawnSync(
        "tar",
        ["--zstd", "-cf", archivePath, "-C", sourceDir, "."],
        {
          encoding: "utf8",
        },
      );
      if (tar.status !== 0)
        throw new Error(`source archive fixture failed: ${tar.stderr}`);
      const archiveBytes = new Uint8Array(await readFile(archivePath));
      const archiveDigest = (await sha256Digest(
        archiveBytes,
      )) as `sha256:${string}`;
      const stateArtifactStore = createFileOpenTofuStateArtifactStore(
        join(tempDir, "encrypted-state-artifacts"),
        STATE_CRYPTO,
      );

      const store = new SqlOpenTofuControlStore({ client });
      let coreCommitRawOutputRef: unknown;
      const commitRunState = store.commitRunState.bind(store);
      store.commitRunState = async (...args) => {
        if (args[0].output)
          coreCommitRawOutputRef = args[0].output.rawArtifactRef;
        return await commitRunState(...args);
      };
      // The account/session and Git transport are synthetic bootstrap inputs.
      // Canonical app ownership is produced only by the real install coordinator.
      const subject = "tsub_native_encrypted_state_fixture" as const;
      const member = "tsub_native_encrypted_state_member" as const;
      const sessionId = crypto.randomUUID();
      const memberSessionId = crypto.randomUUID();
      const accounts = new InMemoryAccountsStore();
      const now = Date.now();
      for (const [accountSubject, cookie, email] of [
        [subject, sessionId, "owner@example.test"],
        [member, memberSessionId, "member@example.test"],
      ] as const) {
        accounts.saveAccount({
          subject: accountSubject,
          email,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        });
        accounts.saveAccountSession({
          sessionId: cookie,
          subject: accountSubject,
          createdAt: now,
          expiresAt: now + 600_000,
        });
      }

      const profile = createLocalOpenTofuRunnerProfile(1);
      const rawOutputRefs: string[] = [];
      const objectKeyAllocator = new ObjectKeyArtifactReferenceAllocator();
      const artifactReferenceAllocator = {
        async allocate(input: ArtifactReferenceAllocation) {
          const ref = await objectKeyAllocator.allocate(input);
          if (input.kind === "raw_output") rawOutputRefs.push(ref);
          return ref;
        },
      };

      await ensureCustodyDirectory(true);
      runRootOwner = await acquireRunRootOwnership(RUN_ROOT);
      runnerServer = Bun.serve({
        port: 0,
        fetch: (request) =>
          handleRunnerRequestWithDependencies(request, {
            mutationCustodyMode: "local-http",
            localPreparationV2: true,
            runRootOwnership: runRootOwner,
          }),
      });
      let applyPosts = 0;
      let successfulApplyAcksDropped = 0;
      let applyCompletionReadsAfterAckLoss = 0;
      let applyRunIdFromDispatch: string | undefined;
      const mutationObservation: {
        preparationAttemptId?: string;
        preparationEpoch?: string;
        completionReadback?: Record<string, unknown>;
        completionReadbackAttemptId: string | null;
        completionReadbackEpoch: string | null;
      } = { completionReadbackAttemptId: null, completionReadbackEpoch: null };
      const routedRequests: string[] = [];
      ackLossProxy = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          const path = url.pathname;
          routedRequests.push(`${request.method} ${path}`);
          let isApplyPost = false;
          if (request.method === "POST" && /^\/runs\/[^/]+$/u.test(path)) {
            const payload = (await request.clone().json()) as {
              action?: string;
            };
            isApplyPost = payload.action === "apply";
            if (isApplyPost) {
              applyPosts += 1;
              applyRunIdFromDispatch = decodeURIComponent(path.split("/")[2]!);
            }
          }
          if (
            request.method === "GET" &&
            /^\/runs\/apply_[^/]+\/completion$/u.test(path) &&
            successfulApplyAcksDropped > 0
          ) {
            applyCompletionReadsAfterAckLoss += 1;
            mutationObservation.completionReadbackAttemptId =
              request.headers.get("x-takosumi-preparation-attempt");
            mutationObservation.completionReadbackEpoch = request.headers.get(
              "x-takosumi-preparation-epoch",
            );
          }
          if (
            request.method === "PUT" &&
            /^\/runs\/apply_[^/]+\/mutation-preparation$/u.test(path)
          ) {
            const preparation = (await request.clone().json()) as {
              attemptId?: string;
            };
            mutationObservation.preparationAttemptId = preparation.attemptId;
          }
          const upstream = await fetch(
            new Request(
              new URL(`${path}${url.search}`, runnerServer!.url),
              request,
            ),
          );
          if (
            request.method === "PUT" &&
            /^\/runs\/apply_[^/]+\/mutation-preparation$/u.test(path) &&
            upstream.status === 201
          ) {
            const reservation = (await upstream.clone().json()) as {
              epoch?: number;
            };
            mutationObservation.preparationEpoch = String(reservation.epoch);
          }
          if (
            request.method === "GET" &&
            /^\/runs\/apply_[^/]+\/completion$/u.test(path) &&
            successfulApplyAcksDropped > 0 &&
            upstream.status === 200
          ) {
            mutationObservation.completionReadback = (await upstream
              .clone()
              .json()) as Record<string, unknown>;
          }
          if (isApplyPost && upstream.status === 200 && applyPosts === 2) {
            // Consume the actual runner's 200 before simulating a transport ACK loss.
            await upstream.arrayBuffer();
            successfulApplyAcksDropped += 1;
            return Response.json(
              { errorCode: "injected_upstream_ack_lost" },
              { status: 502 },
            );
          }
          return upstream;
        },
      });

      const routedHttpRunner = createHttpOpenTofuRunner({
        archiveStore: { write: async () => {}, read: async () => archiveBytes },
        stateStore: stateArtifactStore,
        baseUrl: ackLossProxy.url.href,
      });
      let adapterReturnedRawOutputRef: unknown;
      const routedRunner: OpenTofuRunner = {
        // No Git network: the real archive bytes above are this fixture's input.
        sourceSync: async () => ({
          resolvedCommit: "3".repeat(40),
          archiveDigest,
          archiveSizeBytes: archiveBytes.byteLength,
          repositoryInstallMetadata: { status: "absent" },
          repositoryManifest: { status: "absent" },
          repositoryModules: {
            status: "ready",
            scopePath: ".",
            modules: [
              { path: ".", providerPackages: [], rootProviderRequirements: [] },
            ],
          },
        }),
        cleanupUnusedSourceArchive: async () => {},
        readCapsuleSourceFiles: (job) =>
          routedHttpRunner.readCapsuleSourceFiles!(job),
        plan: async (job, control) => {
          return await routedHttpRunner.plan(job, control);
        },
        apply: async (job, control) => {
          const result = await routedHttpRunner.apply!(job, control);
          adapterReturnedRawOutputRef = result.rawOutputRef;
          return result;
        },
        destroy: (job, control) => routedHttpRunner.destroy!(job, control),
      };
      const created = await createTakosumiService({
        role: "takosumi-api",
        runtimeEnv: {
          TAKOSUMI_DEV_MODE: "1",
          TAKOSUMI_DEPLOY_CONTROL_TOKEN: `test-${id}`,
        },
        sqlClient: client,
        opentofuControlStore: store,
        appOwnershipStore: new SqlAppOwnershipStore(client, store),
        opentofuRunner: routedRunner,
        runnerProfiles: [profile],
        defaultRunnerProfileId: profile.id,
        artifactReferenceAllocator,
        executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
        secretCrypto: STATE_CRYPTO,
      });

      function accountRoute(
        operations: typeof created.operations,
        cookie = sessionId,
      ) {
        return async (
          method: string,
          path: string,
          body?: unknown,
          key?: string,
        ) => {
          const url = new URL(`https://app.example.test${path}`);
          const response = await handleControlRoute({
            request: new Request(url, {
              method,
              headers: {
                cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${cookie}`,
                ...(body === undefined
                  ? {}
                  : { "content-type": "application/json" }),
                ...(key ? { "idempotency-key": key } : {}),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            url,
            store: accounts,
            operations,
          });
          if (!response) throw new Error("fixture_route_not_found");
          return response;
        };
      }
      const route = accountRoute(created.operations);
      const appOwnership = created.operations.appOwnership;
      const appAccess = created.operations.appAccess;
      if (!appOwnership || !appAccess)
        throw new Error("canonical app authority unavailable");
      const workspace = await created.operations.workspaces.createWorkspace({
        handle: `native-owned-${id.slice(0, 20)}`,
        displayName: "Native owned app",
        type: "personal",
        ownerUserId: subject,
      });
      console.log(JSON.stringify({ phase: "normal-installer-ownership" }));
      const installResponse = await route(
        "POST",
        `/api/v1/workspaces/${workspace.id}/install-plans`,
        {
          source: {
            name: "native-output",
            url: "https://github.com/fixture/native-output.git",
            ref: "3".repeat(40),
            path: ".",
          },
          capsule: {
            name: "native-encrypted-update",
            environment: "integration",
          },
          options: { modulePath: ".", providerBindings: [] },
        },
        "native-owned-initial-install",
      );
      if (installResponse.status !== 201) {
        const rejected = await installResponse.clone().json();
        console.log(
          JSON.stringify({
            phase: "initial-install-rejection",
            status: installResponse.status,
            code: rejected.error?.code,
            reason: rejected.error?.details?.reason,
          }),
        );
      }
      expect(installResponse.status).toBe(201);
      const installId = (await installResponse.json()).installPlan.id as string;
      let install: {
        planRunId?: string;
        capsuleId?: string;
        sourceId?: string;
        sourceSnapshotId?: string;
      } = {};
      for (let step = 0; step < 10 && !install.planRunId; step += 1) {
        const next = await route(
          "POST",
          `/api/v1/install-plans/${installId}/reconcile`,
        );
        expect(next.status).toBe(200);
        install = (await next.json()).installPlan;
      }
      expect(install.planRunId).toBeString();
      expect(install.capsuleId).toBeString();
      const capsule = (await store.getCapsule(install.capsuleId!))!;
      const source = (await store.getSource(capsule.sourceId))!;
      const installed = { workspace, capsule, source };
      expect(await appOwnership.getOwnership(capsule.id)).toMatchObject({
        capsuleId: capsule.id,
        ownerAccountId: subject,
        ownershipEpoch: 0,
      });
      expect(
        await appAccess.resolveAppAccess(subject, capsule.id),
      ).toMatchObject({
        capsuleId: capsule.id,
        ownerAccountId: subject,
        role: "owner",
        ownershipEpoch: 0,
      });
      const actualCompatibility = (await store.getCapsuleCompatibilityReport(
        capsule.compatibilityReportId!,
      ))!;
      expect(actualCompatibility.level).toBe("ready");
      expect(actualCompatibility.rootModuleVariables).toContain("public_url");
      expect(actualCompatibility.rootModuleVariableDeclarations).toContainEqual(
        {
          name: "public_url",
          type: "string",
          hasDefault: true,
        },
      );
      const initialPlan = {
        planRun: (await store.getPlanRun(install.planRunId!))!,
      };
      expect(initialPlan.planRun.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(initialPlan.planRun).toMatchObject({
        createdBy: subject,
        ownershipEpoch: 0,
      });
      if (initialPlan.planRun.status === "waiting_approval") {
        expect(
          (
            await route(
              "POST",
              `/api/v1/runs/${initialPlan.planRun.id}/approve`,
            )
          ).status,
        ).toBe(200);
      }
      const initialApplyResponse = await route(
        "POST",
        `/api/v1/runs/${initialPlan.planRun.id}/apply`,
      );
      expect(initialApplyResponse.status).toBe(201);
      const initialApply = await initialApplyResponse.json();
      expect(initialApply.run).toMatchObject({
        status: "succeeded",
        capsuleId: capsule.id,
        planRunId: initialPlan.planRun.id,
      });
      expect(await store.getApplyRun(initialApply.run.id)).toMatchObject({
        createdBy: subject,
        capsuleId: capsule.id,
        planRunId: initialPlan.planRun.id,
      });
      const before = (await store.getCapsule(installed.capsule.id))!;
      const oldState = (await store.getStateVersion(
        before.currentStateVersionId!,
      ))!;
      const oldOutput = (await store.getOutput(before.currentOutputId!))!;
      expect(oldState.generation).toBe(1);
      expect(rawOutputRefs).toHaveLength(1);
      expect(typeof oldOutput.rawArtifactRef).toBe("string");
      expect(oldOutput.rawArtifactRef).toBe(rawOutputRefs[0]);
      expect(adapterReturnedRawOutputRef).toBe(oldOutput.rawArtifactRef);
      expect(coreCommitRawOutputRef).toBe(oldOutput.rawArtifactRef);
      const oldRawOutput = await stateArtifactStore.readRawOutput(
        oldOutput.rawArtifactRef,
      );
      expect(oldRawOutput).toBeDefined();
      expect(Object.keys(oldRawOutput!.outputs).length).toBeGreaterThan(0);
      expect(oldRawOutput!.outputs.launch_url).toMatchObject({
        sensitive: false,
        value: "https://before.example.test",
      });
      const fs = await import("node:fs/promises");
      async function fileManifest(root: string) {
        const entries: { path: string; bytes: Uint8Array }[] = [];
        for (const name of await fs.readdir(root)) {
          const path = join(root, name);
          const stat = await fs.stat(path);
          if (stat.isDirectory()) entries.push(...(await fileManifest(path)));
          else
            entries.push({
              path,
              bytes: new Uint8Array(await fs.readFile(path)),
            });
        }
        return entries;
      }
      const stateRoot = join(tempDir, "encrypted-state-artifacts");
      const oldFiles = await fileManifest(stateRoot);
      expect(oldFiles.length).toBeGreaterThanOrEqual(2);
      expect(
        oldFiles.every(
          (f) => !new TextDecoder().decode(f.bytes).includes('"stateBase64"'),
        ),
      ).toBe(true);
      const oldPlain = (await stateArtifactStore.read(oldState.stateRef))!;
      expect(oldPlain.stateBytes.byteLength).toBeGreaterThan(0);
      console.log(JSON.stringify({ phase: "normal-configuration-api" }));
      const currentResponse = await route(
        "GET",
        `/api/v1/capsules/${installed.capsule.id}`,
      );
      expect(currentResponse.status).toBe(200);
      const currentBody = await currentResponse.json();
      const bindingSet =
        await created.operations.capsules.getProviderBindingSetByCapsule(
          installed.capsule.id,
          installed.capsule.environment,
        );
      expect(bindingSet).toBeDefined();
      const configured = await route(
        "POST",
        `/api/v1/capsules/${installed.capsule.id}/configuration-plans`,
        {
          variablePatch: {
            set: { public_url: "https://after.example.test" },
            remove: [],
          },
          providerBindings: bindingSet!.bindings,
          interfaceBlueprints: [],
          expected: {
            authorityGuard: currentBody.installConfigReAdoption.authorityGuard,
          },
        },
        "local-encrypted-update-v2",
      );
      const configuredBody = await configured.json();
      if (configured.status !== 201)
        console.log(
          JSON.stringify({
            phase: "configuration-rejection",
            status: configured.status,
            code: configuredBody.error?.code,
            reason: configuredBody.error?.details?.reason,
          }),
        );
      expect(configured.status).toBe(201);
      const updatePlan = {
        planRun: (await store.getPlanRun(
          configuredBody.configurationPlan.planRunId,
        ))!,
      };
      expect(updatePlan.planRun.operation).toBe("update");
      expect(updatePlan.planRun.baseStateGeneration).toBe(1);
      expect(updatePlan.planRun.status).toBe("succeeded");
      const planJsonResponse = await fetch(
        new URL(
          `/runs/${updatePlan.planRun.id}/artifacts/tfplan-json`,
          runnerServer.url,
        ),
      );
      expect(planJsonResponse.status).toBe(200);
      const nativePlanJson = await planJsonResponse.json();
      expect(nativePlanJson.output_changes.launch_url.actions).toEqual([
        "update",
      ]);
      expect(nativePlanJson.output_changes.launch_url.before).toBe(
        "https://before.example.test",
      );
      expect(nativePlanJson.output_changes.launch_url.after).toBe(
        "https://after.example.test",
      );
      expect(updatePlan.planRun).toMatchObject({
        createdBy: subject,
        ownershipEpoch: 0,
      });
      if (updatePlan.planRun.status === "waiting_approval") {
        expect(
          (await route("POST", `/api/v1/runs/${updatePlan.planRun.id}/approve`))
            .status,
        ).toBe(200);
      }
      // Explicit management Apply retains the real HTTP driver/Runner/native tofu.
      const updateApplyResponse = await route(
        "POST",
        `/api/v1/runs/${updatePlan.planRun.id}/apply`,
      );
      expect(updateApplyResponse.status).toBe(201);
      const updateApply = await updateApplyResponse.json();
      expect(updateApply.run.status).toBe("succeeded");
      expect(applyPosts).toBe(2);
      expect(successfulApplyAcksDropped).toBe(1);
      expect(applyCompletionReadsAfterAckLoss).toBe(1);
      expect(mutationObservation.completionReadback?.kind).toBe(
        "takosumi.local-mutation-success-readback@v2",
      );
      expect(mutationObservation.preparationAttemptId).toBeTruthy();
      expect(mutationObservation.completionReadbackAttemptId).toBe(
        mutationObservation.preparationAttemptId!,
      );
      expect(mutationObservation.preparationEpoch).toBeTruthy();
      expect(mutationObservation.completionReadbackEpoch).toBe(
        mutationObservation.preparationEpoch!,
      );
      const after = (await store.getCapsule(installed.capsule.id))!;
      const newState = (await store.getStateVersion(
        after.currentStateVersionId!,
      ))!;
      const newOutput = (await store.getOutput(after.currentOutputId!))!;
      expect(after.currentStateGeneration).toBe(2);
      expect(newState.createdByRunId).toBe(updateApply.run.id);
      expect(newState.id).not.toBe(oldState.id);
      expect(newState.stateRef).not.toBe(oldState.stateRef);
      const newPlain = (await stateArtifactStore.read(newState.stateRef))!;
      expect(newPlain.stateDigest).toBe(newState.digest);
      expect(newState.digest).not.toBe(oldState.digest);
      expect(
        JSON.parse(new TextDecoder().decode(oldPlain.stateBytes)).outputs
          .launch_url.value,
      ).toBe("https://before.example.test");
      expect(
        JSON.parse(new TextDecoder().decode(newPlain.stateBytes)).outputs
          .launch_url.value,
      ).toBe("https://after.example.test");
      // The normal generic installer did not declare an output allowlist.
      // Actual raw/state values change below; they are not implicitly public.
      expect(oldOutput.publicOutputs).toEqual({});
      expect(newOutput.publicOutputs).toEqual({});
      expect(rawOutputRefs).toHaveLength(2);
      expect(typeof newOutput.rawArtifactRef).toBe("string");
      expect(newOutput.rawArtifactRef).toBe(rawOutputRefs[1]);
      expect(newOutput.rawArtifactRef).not.toBe(oldOutput.rawArtifactRef);
      expect(adapterReturnedRawOutputRef).toBe(newOutput.rawArtifactRef);
      expect(coreCommitRawOutputRef).toBe(newOutput.rawArtifactRef);
      const updatedRawOutput = await stateArtifactStore.readRawOutput(
        newOutput.rawArtifactRef,
      );
      expect(updatedRawOutput).toBeDefined();
      expect(Object.keys(updatedRawOutput!.outputs).length).toBeGreaterThan(0);
      expect(updatedRawOutput!.outputs.launch_url).toMatchObject({
        sensitive: false,
        value: "https://after.example.test",
      });
      expect(newPlain.createdByRunId).toBe(updateApply.run.id);
      const priorEnvelope = oldFiles.map((f) => ({
        path: f.path,
        hash: createHash("sha256").update(f.bytes).digest("hex"),
      }));
      for (const f of priorEnvelope)
        expect(
          createHash("sha256")
            .update(await readFile(f.path))
            .digest("hex"),
        ).toBe(f.hash);
      const filesAfter = await fileManifest(stateRoot);
      expect(filesAfter.length).toBeGreaterThan(oldFiles.length);
      expect(
        filesAfter.every(
          (f) => !new TextDecoder().decode(f.bytes).includes(testPassphrase),
        ),
      ).toBe(true);
      const admittedMember = await route(
        "POST",
        `/api/v1/capsules/${after.id}/members`,
        {
          email: "member@example.test",
          consent: "connections_and_code",
        },
      );
      expect(admittedMember.status).toBe(202);
      expect(await appAccess.resolveAppAccess(member, after.id)).toMatchObject({
        capsuleId: after.id,
        role: "member",
      });
      // Only this owned DB artifact persists; no key is written or logged.
      console.log(JSON.stringify({ phase: "sql-snapshot-persist" }));
      const snapshot = await client.snapshotDataDir();
      const dbPath = join(tempDir, "data-bearing-database.tar");
      const output = await open(dbPath, "wx", 0o600);
      try {
        await output.writeFile(new Uint8Array(await snapshot.arrayBuffer()));
        await output.sync();
      } finally {
        await output.close();
      }
      await client.close();
      const snapshotBytes = new Uint8Array(await readFile(dbPath));
      console.log(JSON.stringify({ phase: "fresh-db-reconstruction" }));
      reopenedClient = await PGliteSqlClient.fromDataDirSnapshot(
        new Blob([snapshotBytes]),
      );
      const freshCrypto = newCrypto();
      expect(freshCrypto).not.toBe(STATE_CRYPTO);
      const freshFileStore = createFileOpenTofuStateArtifactStore(
        stateRoot,
        freshCrypto,
      );
      const freshRunner = createHttpOpenTofuRunner({
        archiveStore: { write: async () => {}, read: async () => archiveBytes },
        stateStore: freshFileStore,
        baseUrl: ackLossProxy.url.href,
      });
      const freshStore = new SqlOpenTofuControlStore({
        client: reopenedClient,
      });
      const fresh = await createTakosumiService({
        role: "takosumi-api",
        runtimeEnv: {
          TAKOSUMI_DEV_MODE: "1",
          TAKOSUMI_DEPLOY_CONTROL_TOKEN: `test-${id}`,
        },
        sqlClient: reopenedClient,
        opentofuControlStore: freshStore,
        appOwnershipStore: new SqlAppOwnershipStore(reopenedClient, freshStore),
        opentofuRunner: freshRunner,
        runnerProfiles: [createLocalOpenTofuRunnerProfile(1)],
        defaultRunnerProfileId: profile.id,
        artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
        executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
        secretCrypto: freshCrypto,
      });
      const freshRoute = accountRoute(fresh.operations);
      const freshMemberRoute = accountRoute(fresh.operations, memberSessionId);
      expect(
        await fresh.operations.appAccess!.resolveAppAccess(subject, after.id),
      ).toMatchObject({
        capsuleId: after.id,
        ownerAccountId: subject,
        role: "owner",
        ownershipEpoch: 0,
      });
      expect(
        await fresh.operations.appAccess!.resolveAppAccess(member, after.id),
      ).toMatchObject({
        capsuleId: after.id,
        role: "member",
      });
      const recoveredResponse = await freshRoute(
        "GET",
        `/api/v1/runs/${updateApply.run.id}`,
      );
      expect(recoveredResponse.status).toBe(200);
      expect((await recoveredResponse.json()).run).toMatchObject({
        id: updateApply.run.id,
        status: "succeeded",
        planRunId: updatePlan.planRun.id,
      });
      expect((await fresh.operations.getRun(updateApply.run.id)).id).toBe(
        updateApply.run.id,
      );
      expect((await fresh.operations.getRun(updateApply.run.id)).status).toBe(
        "succeeded",
      );
      expect(await freshStore.getCapsule(after.id)).toEqual(after);
      expect(await freshStore.getStateVersion(oldState.id)).toEqual(oldState);
      expect(await freshStore.getStateVersion(newState.id)).toEqual(newState);
      expect(await freshStore.getOutput(oldOutput.id)).toEqual(oldOutput);
      expect(await freshStore.getOutput(newOutput.id)).toEqual(newOutput);
      console.log(JSON.stringify({ phase: "fresh-crypto-readback" }));
      const recoveredOld = (await freshFileStore.read(oldState.stateRef))!;
      const recoveredNew = (await freshFileStore.read(newState.stateRef))!;
      expect(recoveredOld.stateBytes).toEqual(oldPlain.stateBytes);
      expect(recoveredNew.stateBytes).toEqual(newPlain.stateBytes);
      expect(recoveredNew.stateDigest).toBe(newState.digest);
      expect(recoveredNew.createdByRunId).toBe(updateApply.run.id);
      const freshOldRawOutput = await freshFileStore.readRawOutput(
        oldOutput.rawArtifactRef,
      );
      const freshNewRawOutput = await freshFileStore.readRawOutput(
        newOutput.rawArtifactRef,
      );
      expect(freshOldRawOutput).toBeDefined();
      expect(freshNewRawOutput).toBeDefined();
      expect(Object.keys(freshNewRawOutput!.outputs).length).toBeGreaterThan(0);
      expect(freshOldRawOutput!.outputs.launch_url).toMatchObject({
        sensitive: false,
        value: "https://before.example.test",
      });
      expect(freshNewRawOutput!.outputs.launch_url).toMatchObject({
        sensitive: false,
        value: "https://after.example.test",
      });
      expect(freshOldRawOutput!.outputs).toEqual(oldRawOutput!.outputs);
      expect(freshNewRawOutput!.outputs).toEqual(updatedRawOutput!.outputs);
      // Both current roles survived SQL reconstruction. A known Run ID grants nothing.
      expect(
        (await freshMemberRoute("GET", `/api/v1/runs/${updateApply.run.id}`))
          .status,
      ).toBe(200);
      const runIds = (await fresh.operations.listRuns(workspace.id))
        .map((run) => run.id)
        .sort();
      expect(runIds).toContain(updateApply.run.id);
      const effectiveConfig = await fresh.operations.capsules.getInstallConfig(
        after.installConfigId!,
      );
      const runnerRequests = routedRequests.length;
      expect(
        (
          await freshRoute(
            "DELETE",
            `/api/v1/capsules/${after.id}/members/${member}`,
          )
        ).status,
      ).toBe(204);
      expect(
        await fresh.operations.appAccess!.resolveAppAccess(member, after.id),
      ).toBeUndefined();
      const deniedConfig = {
        variablePatch: {
          set: { public_url: "https://denied.example.test" },
          remove: [],
        },
        providerBindings: [],
        interfaceBlueprints: [],
        expected: {
          authorityGuard: currentBody.installConfigReAdoption.authorityGuard,
        },
      };
      for (const deniedRoute of [freshMemberRoute, freshRoute]) {
        const status = deniedRoute === freshMemberRoute ? 403 : 401;
        if (status === 401) await accounts.deleteAccountSession(sessionId);
        expect(
          (await deniedRoute("GET", `/api/v1/runs/${updateApply.run.id}`))
            .status,
        ).toBe(status);
        expect(
          (
            await deniedRoute(
              "POST",
              `/api/v1/runs/${updatePlan.planRun.id}/apply`,
            )
          ).status,
        ).toBe(status);
        expect(
          (
            await deniedRoute(
              "POST",
              `/api/v1/capsules/${after.id}/configuration-plans`,
              deniedConfig,
              `denied-native-${status}`,
            )
          ).status,
        ).toBe(status);
        expect(routedRequests).toHaveLength(runnerRequests);
        expect(applyPosts).toBe(2);
        expect(await freshStore.getCapsule(after.id)).toEqual(after);
        expect(
          await fresh.operations.capsules.getInstallConfig(
            after.installConfigId!,
          ),
        ).toEqual(effectiveConfig);
        expect(
          (await fresh.operations.listRuns(workspace.id))
            .map((run) => run.id)
            .sort(),
        ).toEqual(runIds);
        expect(await fileManifest(stateRoot)).toEqual(filesAfter);
      }
      const wrongCrypto = new PartitionedSecretBoundaryCrypto({
        globalPassphrase: Buffer.from(
          crypto.getRandomValues(new Uint8Array(48)),
        ).toString("hex"),
      });
      await expect(
        createFileOpenTofuStateArtifactStore(stateRoot, wrongCrypto).read(
          newState.stateRef,
        ),
      ).rejects.toBeDefined();
      // Raw-output envelopes also contain stateRef. Select the state purpose,
      // not whichever serialized artifact happens to contain that substring.
      const stateEnvelopes = filesAfter.filter((file) => {
        const envelope = JSON.parse(new TextDecoder().decode(file.bytes));
        return (
          envelope.version === 2 &&
          envelope.stateRef === newState.stateRef &&
          envelope.createdByRunId === updateApply.run.id
        );
      });
      expect(stateEnvelopes).toHaveLength(1);
      const newEnvelopeFile = stateEnvelopes[0]!;
      const envelope = JSON.parse(
        new TextDecoder().decode(newEnvelopeFile.bytes),
      );
      expect(envelope.workspaceId).toBe(workspace.id);
      const changed = { ...envelope, workspaceId: "different-fixture-scope" };
      await writeFile(newEnvelopeFile.path, JSON.stringify(changed), {
        mode: 0o600,
      });
      await expect(
        freshFileStore.read(newState.stateRef),
      ).rejects.toBeDefined();
      await writeFile(newEnvelopeFile.path, newEnvelopeFile.bytes, {
        mode: 0o600,
      });
      expect(
        (await freshFileStore.read(newState.stateRef))?.stateBytes,
      ).toEqual(newPlain.stateBytes);
      expect(applyPosts).toBe(2);
      expect(await freshStore.getStateVersion(oldState.id)).toEqual(oldState);
      console.log(
        JSON.stringify({
          category:
            "native-provider-free-encrypted-update-persisted-reconstruction",
          generation: 2,
          actualCiphertextFiles: true,
          actualNativeTofu: true,
          nativeOutputChangeAsserted: true,
          declaredUserInputChangedByConfigurationAPI: true,
          persistedSqlSnapshotRead: true,
          freshCryptoAndStores: true,
          freshNonemptyRawOutputBothGenerations: true,
          rawOutputRefsLinkedToActualProducer: true,
          sameRunRead: true,
          actualInstallerOwnershipAndCurrentAppAccess: true,
          persistedMemberRoleRecheckedAfterReconstruction: true,
          removedMemberAndRevokedSessionDeniedKnownIds: true,
          rejectedRequestsPreserveCapsuleConfigRunsAndCiphertext: true,
          secondApplyDispatches: 1,
          recoveryAdditionalApply: 0,
          oldFilesPreserved: true,
          wrongKeyAndScopeRejected: true,
          keyPersisted: false,
        }),
      );
    } finally {
      ackLossProxy?.stop(true);
      await runnerServer?.stop();
      await runRootOwner?.close();
      if (reopenedClient && !reopenedClient.closed)
        await reopenedClient.close();
      if (!client.closed) await client.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
}
