import { expect, test } from "bun:test";
import {
  cachedServiceAttempt,
  createInProcessDeployControlSeam,
  deployControlServiceOptions,
  executionEvidenceAuthorityFromComposition,
  executionEvidenceAuthorityFromEnv,
} from "../../../worker/src/deploy_control_seam.ts";
import { createCloudflareWorker } from "../../../worker/src/handler.ts";
import type {
  CloudflareWorkerEnv,
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../../worker/src/bindings.ts";
import {
  createDefaultRunnerProfiles,
  type OpenTofuRunner,
} from "../../../core/domains/deploy-control/mod.ts";

test("deploy and RunOwner service caches evict rejected attempts but share pending ones", async () => {
  for (const cacheKind of ["deploy", "run-owner"] as const) {
    const cache = new WeakMap<object, Promise<{ readonly generation: number }>>();
    const env = {};
    let attempts = 0;
    let rejectFirst: ((error: unknown) => void) | undefined;
    const firstPending = new Promise<{ readonly generation: number }>(
      (_, reject) => {
        rejectFirst = reject;
      },
    );
    const first = cachedServiceAttempt(cache, env, async () => {
      attempts += 1;
      return await firstPending;
    });
    expect(cachedServiceAttempt(cache, env, async () => ({ generation: 99 }))).toBe(
      first,
    );
    await Promise.resolve();
    expect(attempts).toBe(1);

    rejectFirst!(new Error(`${cacheKind} bootstrap failed`));
    await first.catch((error) => expect(error).toBeInstanceOf(Error));

    const retry = cachedServiceAttempt(cache, env, async () => {
      attempts += 1;
      return { generation: 2 };
    });
    expect(retry).not.toBe(first);
    expect(cachedServiceAttempt(cache, env, async () => ({ generation: 99 }))).toBe(
      retry,
    );
    await expect(retry).resolves.toEqual({ generation: 2 });
    expect(attempts).toBe(2);

    // Simulate a future generation reset racing the stale rejection. The old
    // attempt must not delete the newer cache entry.
    const fencedEnv = {};
    let rejectStale: ((error: unknown) => void) | undefined;
    const stalePending = new Promise<{ readonly generation: number }>(
      (_, reject) => {
        rejectStale = reject;
      },
    );
    const stale = cachedServiceAttempt(cache, fencedEnv, async () => stalePending);
    await Promise.resolve();
    const newer = Promise.resolve({ generation: 3 });
    cache.set(fencedEnv, newer);
    rejectStale!(new Error("stale generation"));
    await stale.catch((error) => expect(error).toBeInstanceOf(Error));
    expect(cache.get(fencedEnv)).toBe(newer);
  }
});

test("Worker composition accepts explicit host RunnerProfiles and executors", () => {
  const reference = createDefaultRunnerProfiles(1)[0]!;
  const privateNetworkRunner = {} as OpenTofuRunner;
  const options = deployControlServiceOptions({
    TAKOSUMI_ENABLED_RUNNER_PROFILES: "private-network,opentofu-default",
    TAKOSUMI_DEFAULT_RUNNER_PROFILE_ID: "private-network",
    TAKOSUMI_RUNNER_HOST_COMPOSITION: {
      profiles: [
        {
          ...reference,
          id: "private-network",
          name: "Private network",
          executorId: "operator.private-network",
          lifecycle: { state: "candidate" },
        },
      ],
      executors: new Map([["operator.private-network", privateNetworkRunner]]),
    },
  } as unknown as CloudflareWorkerEnv);

  expect(options.runnerProfiles.map((profile) => profile.id)).toEqual([
    "private-network",
    "opentofu-default",
  ]);
  expect(options.runnerProfiles[0]?.lifecycle.state).toBe("active");
  expect(options.defaultRunnerProfileId).toBe("private-network");
  expect(options.runnerExecutors?.get("operator.private-network")).toBe(
    privateNetworkRunner,
  );
});

test("Worker composition forwards explicit immutable execution evidence authority", () => {
  const authority = {
    controllerArtifact: { digest: `sha256:${"a".repeat(64)}`, immutable: true },
    runnerArtifact: { digest: `sha256:${"b".repeat(64)}`, immutable: true },
    executorArtifact: { digest: `sha256:${"c".repeat(64)}`, immutable: true },
  } as const;
  const options = deployControlServiceOptions({
    TAKOSUMI_RUNNER_HOST_COMPOSITION: {
      profiles: [],
      executionEvidenceAuthority: authority,
    },
  } as unknown as CloudflareWorkerEnv);

  expect(options.executionEvidenceAuthority).toEqual(authority);
});

test("Worker composition resolves release-pinned execution evidence authority from raw env", () => {
  const options = deployControlServiceOptions({
    TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`,
    TAKOSUMI_RUNNER_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`,
    TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST: `sha256:${"b".repeat(64)}`,
  } as unknown as CloudflareWorkerEnv);

  expect(options.executionEvidenceAuthority).toEqual({
    controllerArtifact: {
      digest: `sha256:${"a".repeat(64)}`,
      immutable: true,
    },
    runnerArtifact: {
      digest: `sha256:${"a".repeat(64)}`,
      immutable: true,
    },
    executorArtifact: {
      digest: `sha256:${"b".repeat(64)}`,
      immutable: true,
    },
  });
});

test("Worker composition rejects partial, mutable, or conflicting release pins", () => {
  expect(() =>
    executionEvidenceAuthorityFromEnv({
      TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`,
    }),
  ).toThrow("execution evidence authority is incomplete");
  expect(() =>
    executionEvidenceAuthorityFromEnv({
      TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST: "controller:latest",
      TAKOSUMI_RUNNER_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`,
      TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST: `sha256:${"b".repeat(64)}`,
    }),
  ).toThrow("must be an exact sha256 digest");
  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`,
      TAKOSUMI_RUNNER_ARTIFACT_DIGEST: `sha256:${"a".repeat(64)}`,
      TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST: `sha256:${"b".repeat(64)}`,
      TAKOSUMI_RUNNER_HOST_COMPOSITION: {
        profiles: [],
        executionEvidenceAuthority: {
          controllerArtifact: {
            digest: `sha256:${"c".repeat(64)}`,
            immutable: true,
          },
          runnerArtifact: {
            digest: `sha256:${"a".repeat(64)}`,
            immutable: true,
          },
          executorArtifact: {
            digest: `sha256:${"b".repeat(64)}`,
            immutable: true,
          },
        },
      },
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("execution evidence authority conflicts with release pins");
});

test("Worker composition validates host evidence authority as a closed identity", () => {
  expect(() =>
    executionEvidenceAuthorityFromComposition({
      controllerArtifact: {
        digest: `sha256:${"a".repeat(64)}`,
        immutable: true,
        label: "mutable-alias",
      },
      runnerArtifact: {
        digest: `sha256:${"a".repeat(64)}`,
        immutable: true,
      },
      executorArtifact: {
        digest: `sha256:${"b".repeat(64)}`,
        immutable: true,
      },
    }),
  ).toThrow("authority is invalid");
  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_RUNNER_HOST_COMPOSITION: {
        profiles: [],
        executionEvidenceAuthority: {
          controllerArtifact: {
            digest: `sha256:${"a".repeat(64)}`,
            immutable: true,
          },
          runnerArtifact: {
            digest: `sha256:${"a".repeat(64)}`,
            immutable: true,
          },
          executorArtifact: {
            digest: `sha256:${"b".repeat(64)}`,
            immutable: true,
          },
          unexpected: true,
        } as never,
      },
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("authority is not closed");
});

test("Worker composition rejects duplicate built-in profile ids", () => {
  const reference = createDefaultRunnerProfiles(1)[0]!;
  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_RUNNER_HOST_COMPOSITION: { profiles: [reference] },
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("duplicate profile opentofu-default");
});

test("Worker composition rejects a missing or non-array profile catalog", () => {
  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_RUNNER_HOST_COMPOSITION: {},
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("profiles must be an array");
  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_RUNNER_HOST_COMPOSITION: { profiles: "opentofu-default" },
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("profiles must be an array");
});

test("Worker composition rejects partial profiles and unknown composition keys", () => {
  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_RUNNER_HOST_COMPOSITION: {
        profiles: [{ id: "private-network" }],
      },
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("runner profile private-network");
  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_RUNNER_HOST_COMPOSITION: {
        profiles: [],
        unexpected: true,
      },
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("unknown key unexpected");
});

test("Worker composition rejects unknown nested profile keys", () => {
  const reference = createDefaultRunnerProfiles(1)[0]!;
  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_RUNNER_HOST_COMPOSITION: {
        profiles: [
          {
            ...reference,
            id: "private-network",
            executorId: "operator.private-network",
            lifecycle: {
              ...reference.lifecycle,
              credentialRef: "vault://unexpected",
            },
          },
        ],
      },
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("unknown key credentialRef");
});

test("Worker composition rejects profile authority that conflicts with release pins", () => {
  const reference = createDefaultRunnerProfiles(1)[0]!;
  const releaseAuthority = {
    controllerArtifact: { digest: `sha256:${"a".repeat(64)}`, immutable: true },
    runnerArtifact: { digest: `sha256:${"b".repeat(64)}`, immutable: true },
    executorArtifact: { digest: `sha256:${"c".repeat(64)}`, immutable: true },
  } as const;
  const profileAuthority = {
    ...releaseAuthority,
    executorArtifact: { digest: `sha256:${"d".repeat(64)}`, immutable: true },
  } as const;

  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_ENABLED_RUNNER_PROFILES: "private-network",
      TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST:
        releaseAuthority.controllerArtifact.digest,
      TAKOSUMI_RUNNER_ARTIFACT_DIGEST:
        releaseAuthority.runnerArtifact.digest,
      TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST:
        releaseAuthority.executorArtifact.digest,
      TAKOSUMI_RUNNER_HOST_COMPOSITION: {
        profiles: [
          {
            ...reference,
            id: "private-network",
            executorId: "operator.private-network",
            executionEvidenceAuthority: profileAuthority,
          },
        ],
      },
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("execution evidence authority conflicts");
});

test("Worker composition accepts profile authority equal to release pins", () => {
  const reference = createDefaultRunnerProfiles(1)[0]!;
  const authority = {
    controllerArtifact: { digest: `sha256:${"a".repeat(64)}`, immutable: true },
    runnerArtifact: { digest: `sha256:${"b".repeat(64)}`, immutable: true },
    executorArtifact: { digest: `sha256:${"c".repeat(64)}`, immutable: true },
  } as const;
  const options = deployControlServiceOptions({
    TAKOSUMI_ENABLED_RUNNER_PROFILES: "private-network",
    TAKOSUMI_CONTROLLER_ARTIFACT_DIGEST: authority.controllerArtifact.digest,
    TAKOSUMI_RUNNER_ARTIFACT_DIGEST: authority.runnerArtifact.digest,
    TAKOSUMI_EXECUTOR_ARTIFACT_DIGEST: authority.executorArtifact.digest,
    TAKOSUMI_RUNNER_HOST_COMPOSITION: {
      profiles: [
        {
          ...reference,
          id: "private-network",
          executorId: "operator.private-network",
          executionEvidenceAuthority: authority,
        },
      ],
    },
  } as unknown as CloudflareWorkerEnv);

  expect(options.executionEvidenceAuthority).toEqual(authority);
  expect(options.runnerProfiles[0]?.executionEvidenceAuthority).toEqual(
    authority,
  );
});

test("Worker composition rejects a text RunnerProfile catalog", () => {
  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_RUNNER_HOST_COMPOSITION: JSON.stringify({ profiles: [] }),
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("must be a host-code runtime object");
});

test("Worker composition accepts only a host-code Interface OAuth resource authorizer", async () => {
  const authorizer = async () => true;
  const options = deployControlServiceOptions({
    TAKOSUMI_INTERFACE_OAUTH2_RESOURCE_AUTHORIZER: authorizer,
  } as unknown as CloudflareWorkerEnv);
  expect(options.interfaceOAuth2ResourceAuthorizer).toBe(authorizer);
  await expect(
    options.interfaceOAuth2ResourceAuthorizer!({
      workspaceId: "workspace_1",
      interfaceId: "interface_1",
      ownerRef: { kind: "Capsule", id: "capsule_1" },
      resource: "https://app.takosumi.com/v1/cloud/resources",
    }),
  ).resolves.toBeTrue();

  expect(() =>
    deployControlServiceOptions({
      TAKOSUMI_INTERFACE_OAUTH2_RESOURCE_AUTHORIZER: "true",
    } as unknown as CloudflareWorkerEnv),
  ).toThrow("must be a host-code function");
});

test("Worker composition mounts ledger HTTP routes only for explicit private ingress", () => {
  expect(
    deployControlServiceOptions({} as unknown as CloudflareWorkerEnv)
      .mountInternalLedgerRoutes,
  ).toBeUndefined();
  expect(
    deployControlServiceOptions({
      LOCAL_SUBSTRATE_TEST_BED: "1",
    } as unknown as CloudflareWorkerEnv).mountInternalLedgerRoutes,
  ).toBe(true);
  expect(
    deployControlServiceOptions({
      TAKOSUMI_EXPOSE_INTERNAL_EDGE: "1",
    } as unknown as CloudflareWorkerEnv).mountInternalLedgerRoutes,
  ).toBe(true);
});

/**
 * The ledger bootstrap is expensive on a cold, freshly provisioned Worker even
 * after batching, so it must never sit in front of a request that does not
 * need the ledger. The seam is deliberately lazy: constructing it touches no
 * binding, and the Worker's own dispatcher answers `/healthz` and unmatched
 * paths before it ever resolves the service.
 */
class BlockedControlD1 implements D1Database {
  uses = 0;

  prepare(_query: string): D1PreparedStatement {
    this.uses += 1;
    const pending = <T>(): Promise<T> => new Promise<T>(() => {});
    const statement: D1PreparedStatement = {
      bind: () => statement,
      first: pending,
      all: pending,
      raw: pending,
      run: pending,
    };
    return statement;
  }

  batch<T = unknown>(): Promise<readonly D1Result<T>[]> {
    this.uses += 1;
    return new Promise<readonly D1Result<T>[]>(() => {});
  }
}

test("constructing the deploy-control seam starts no schema bootstrap", () => {
  const controlDb = new BlockedControlD1();
  const env = {
    TAKOSUMI_CONTROL_DB: controlDb,
  } as unknown as CloudflareWorkerEnv;

  const seam = createInProcessDeployControlSeam(env);

  expect(typeof seam.fetch).toBe("function");
  expect(typeof seam.operations).toBe("function");
  expect(controlDb.uses).toBe(0);
});

test("requests that do not need the ledger never wait on the bootstrap", async () => {
  const controlDb = new BlockedControlD1();
  const env = {
    TAKOSUMI_CONTROL_DB: controlDb,
  } as unknown as CloudflareWorkerEnv;
  const worker = createCloudflareWorker();

  // A control-plane request legitimately waits for the bootstrap; hold one open
  // so the seam's pending attempt is genuinely in flight.
  const blocked = worker.fetch(
    new Request("https://worker.example/capabilities"),
    env,
  );
  let blockedSettled = false;
  void blocked.then(
    () => {
      blockedSettled = true;
    },
    () => {
      blockedSettled = true;
    },
  );
  await Promise.resolve();

  const health = await worker.fetch(
    new Request("https://worker.example/healthz"),
    env,
  );
  expect(health.status).toBe(200);

  const unmatched = await worker.fetch(
    new Request("https://worker.example/not-a-route"),
    env,
  );
  expect(unmatched.status).toBe(404);

  expect(blockedSettled).toBe(false);
});
