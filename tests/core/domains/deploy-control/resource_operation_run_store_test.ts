import { afterAll, expect, setDefaultTimeout, test } from "bun:test";

import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
  type ResourceOperationRun,
} from "../../../../core/domains/deploy-control/store.ts";
import type { InstalledFormReference } from "takosumi-contract";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { RunQueryService } from "../../../../core/domains/deploy-control/run_query.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(20_000);

const clients: PGliteSqlClient[] = [];
const CREATED_AT = "2026-07-14T00:00:00.000Z";
const EXACT_FORM: InstalledFormReference = {
  formRef: {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ObjectBucket",
    definitionVersion: "1.0.0",
    schemaDigest: `sha256:${"1".repeat(64)}`,
  },
  packageDigest: `sha256:${"2".repeat(64)}`,
};

afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const client = await PGliteSqlClient.create();
  clients.push(client);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

function resourceRun(
  overrides: Partial<ResourceOperationRun> = {},
): ResourceOperationRun {
  return {
    id: "run_resource_apply_assets",
    workspaceId: "space_a",
    subject: {
      kind: "resource",
      id: "tkrn:space_a:ObjectBucket:assets",
    },
    resourceOperation: "apply",
    resourceOperationKey: "sha256:apply-assets-v1",
    resourceOperationVersion: 1,
    type: "apply",
    status: "running",
    createdBy: "account_a",
    createdAt: CREATED_AT,
    startedAt: CREATED_AT,
    ...overrides,
  };
}

test("direct Resource Run CAS is insert-only, monotonic, and backend-equivalent", async () => {
  for (const [label, store] of await stores()) {
    const initial = resourceRun();
    await expect(
      Promise.resolve().then(() =>
        store.beginResourceOperationRun(
          resourceRun({
            id: `invalid-start-${label}`,
            status: "succeeded",
            finishedAt: CREATED_AT,
          }),
        ),
      ),
    ).rejects.toThrow("must start at running version 1");
    expect(await store.beginResourceOperationRun(initial)).toEqual({
      status: "created",
      run: initial,
    });

    const idempotentRetry = resourceRun({
      createdAt: "2026-07-14T00:00:01.000Z",
      startedAt: "2026-07-14T00:00:01.000Z",
    });
    expect(
      (await store.beginResourceOperationRun(idempotentRetry)).status,
    ).toBe("existing");
    expect(
      (
        await store.beginResourceOperationRun(
          resourceRun({ resourceOperationKey: "sha256:different" }),
        )
      ).status,
    ).toBe("conflict");

    const withResult: ResourceOperationRun = {
      ...initial,
      resourceOperationVersion: 2,
      resourceOperationResult: {
        summary: "created one bucket",
        nativeResources: [{ type: "r2_bucket", id: "bucket-assets" }],
        outputs: { bucket_name: "assets" },
      },
    };
    expect(
      await store.transitionResourceOperationRun({
        id: initial.id,
        operationKey: initial.resourceOperationKey,
        expectedVersion: 1,
        expectFrom: ["running"],
        run: withResult,
      }),
    ).toEqual({ won: true, run: withResult });

    const staged: ResourceOperationRun = {
      ...withResult,
      resourceOperationVersion: 3,
      resourceOperationAudit: {
        status: "pending",
        eventId: `act_${initial.id}`,
        action: "resource.apply.succeeded",
        metadata: { generation: 1, phase: "Ready" },
        createdAt: "2026-07-14T00:00:02.000Z",
      },
    };
    const competingStage: ResourceOperationRun = {
      ...withResult,
      resourceOperationVersion: 3,
      resourceOperationAudit: {
        status: "pending",
        eventId: `act_competing_${initial.id}`,
        action: "resource.apply.succeeded",
        metadata: { generation: 1, phase: "Ready", contender: true },
        createdAt: "2026-07-14T00:00:02.000Z",
      },
    };
    const races = await Promise.all([
      store.transitionResourceOperationRun({
        id: initial.id,
        operationKey: initial.resourceOperationKey,
        expectedVersion: 2,
        expectFrom: ["running"],
        run: staged,
      }),
      store.transitionResourceOperationRun({
        id: initial.id,
        operationKey: initial.resourceOperationKey,
        expectedVersion: 2,
        expectFrom: ["running"],
        run: competingStage,
      }),
    ]);
    expect(races.filter((result) => result.won)).toHaveLength(1);
    const current = await store.getResourceOperationRun(initial.id);
    expect(current).toBeDefined();
    expect(current?.resourceOperationVersion).toBe(3);

    const recoverable = await store.listRecoverableResourceOperationRuns({
      workspaceId: initial.workspaceId,
    });
    expect(recoverable.map((run) => run.id)).toEqual([initial.id]);
    expect(
      await store.listRecoverableResourceOperationRuns({
        workspaceId: `other-${label}`,
      }),
    ).toEqual([]);
  }
});

test("terminal Resource Run outcomes cannot be overwritten; only audit acknowledgement advances", async () => {
  for (const [, store] of await stores()) {
    const initial = resourceRun();
    await store.beginResourceOperationRun(initial);
    const succeeded: ResourceOperationRun = {
      ...initial,
      status: "succeeded",
      finishedAt: "2026-07-14T00:00:03.000Z",
      resourceOperationVersion: 2,
      resourceOperationResult: {
        summary: "created one bucket",
        nativeResources: [{ type: "r2_bucket", id: "bucket-assets" }],
        outputs: { bucket_name: "assets" },
      },
      resourceOperationAudit: {
        status: "pending",
        eventId: `act_${initial.id}`,
        action: "resource.apply.succeeded",
        metadata: { generation: 1, phase: "Ready" },
        createdAt: "2026-07-14T00:00:03.000Z",
      },
    };
    expect(
      (
        await store.transitionResourceOperationRun({
          id: initial.id,
          operationKey: initial.resourceOperationKey,
          expectedVersion: 1,
          expectFrom: ["running"],
          run: succeeded,
        })
      ).won,
    ).toBe(true);

    const overwritten: ResourceOperationRun = {
      ...succeeded,
      status: "failed",
      errorCode: "rewritten",
      resourceOperationVersion: 3,
    };
    expect(
      (
        await store.transitionResourceOperationRun({
          id: initial.id,
          operationKey: initial.resourceOperationKey,
          expectedVersion: 2,
          expectFrom: ["succeeded"],
          run: overwritten,
        })
      ).won,
    ).toBe(false);

    const acknowledged: ResourceOperationRun = {
      ...succeeded,
      resourceOperationVersion: 3,
      resourceOperationAudit: {
        ...succeeded.resourceOperationAudit!,
        status: "completed",
      },
    };
    expect(
      (
        await store.transitionResourceOperationRun({
          id: initial.id,
          operationKey: initial.resourceOperationKey,
          expectedVersion: 2,
          expectFrom: ["succeeded"],
          run: acknowledged,
        })
      ).won,
    ).toBe(true);
    expect(await store.listRecoverableResourceOperationRuns()).toEqual([]);
  }
});

test("running artifact Runs cannot starve bounded recovery of terminal audit work", async () => {
  for (const [, store] of await stores()) {
    for (let index = 0; index < 3; index += 1) {
      await store.beginResourceOperationRun(
        resourceRun({
          id: `run_artifact_running_${index}`,
          subject: {
            kind: "resource",
            id: `tkrn:space_a:EdgeWorker:running-${index}`,
          },
          resourceOperation: "artifact",
          resourceOperationKey: `sha256:artifact-running-${index}`,
          type: "artifact",
          createdAt: `2026-07-14T00:00:0${index}.000Z`,
          startedAt: `2026-07-14T00:00:0${index}.000Z`,
        }),
      );
    }

    const staged = resourceRun({
      id: "run_artifact_staged",
      subject: {
        kind: "resource",
        id: "tkrn:space_a:EdgeWorker:staged",
      },
      resourceOperation: "artifact",
      resourceOperationKey: "sha256:artifact-staged",
      type: "artifact",
      createdAt: "2026-07-14T00:00:03.000Z",
      startedAt: "2026-07-14T00:00:03.000Z",
    });
    await store.beginResourceOperationRun(staged);
    const succeeded: ResourceOperationRun = {
      ...staged,
      status: "succeeded",
      finishedAt: "2026-07-14T00:00:04.000Z",
      resourceOperationVersion: 2,
      resourceOperationResult: {
        summary: "staged worker release",
        artifact: {
          kind: "worker_release",
          ref: `artifact:v1:sha256:${"a".repeat(64)}`,
          digest: `sha256:${"a".repeat(64)}`,
          sizeBytes: 128,
        },
      },
      resourceOperationAudit: {
        status: "pending",
        eventId: `act_${staged.id}`,
        action: "resource.artifact.staged",
        metadata: { purpose: "worker_release" },
        createdAt: "2026-07-14T00:00:04.000Z",
      },
    };
    expect(
      (
        await store.transitionResourceOperationRun({
          id: staged.id,
          operationKey: staged.resourceOperationKey,
          expectedVersion: 1,
          expectFrom: ["running"],
          run: succeeded,
        })
      ).won,
    ).toBe(true);

    const ordinary = resourceRun({
      id: "run_resource_apply_after_artifacts",
      subject: {
        kind: "resource",
        id: "tkrn:space_a:ObjectBucket:after-artifacts",
      },
      resourceOperationKey: "sha256:apply-after-artifacts",
      createdAt: "2026-07-14T00:00:05.000Z",
      startedAt: "2026-07-14T00:00:05.000Z",
    });
    await store.beginResourceOperationRun(ordinary);

    expect(
      (await store.listRecoverableResourceOperationRuns({ limit: 1 })).map(
        (run) => run.id,
      ),
    ).toEqual([staged.id]);
    expect(
      (await store.listRecoverableResourceOperationRuns({ limit: 2 })).map(
        (run) => run.id,
      ),
    ).toEqual([staged.id, ordinary.id]);
  }
});

test("exact Resource Run and NativeResource evidence round trip without permitting Form substitution", async () => {
  for (const [, store] of await stores()) {
    const initial = resourceRun({ resourceForm: EXACT_FORM });
    expect(await store.beginResourceOperationRun(initial)).toMatchObject({
      status: "created",
      run: { resourceForm: EXACT_FORM },
    });
    const withResult: ResourceOperationRun = {
      ...initial,
      resourceOperationVersion: 2,
      resourceOperationResult: {
        summary: "created exact bucket",
        resourceForm: EXACT_FORM,
        nativeResources: [
          {
            type: "r2_bucket",
            id: "bucket-assets",
            form: EXACT_FORM,
          },
        ],
        outputs: { bucket_name: "assets" },
      },
    };
    expect(
      (
        await store.transitionResourceOperationRun({
          id: initial.id,
          operationKey: initial.resourceOperationKey,
          expectedVersion: 1,
          expectFrom: ["running"],
          run: withResult,
        })
      ).won,
    ).toBe(true);
    expect(await store.getResourceOperationRun(initial.id)).toEqual(withResult);

    const substituted: ResourceOperationRun = {
      ...withResult,
      resourceOperationVersion: 3,
      resourceForm: {
        ...EXACT_FORM,
        packageDigest: `sha256:${"9".repeat(64)}`,
      },
    };
    expect(
      (
        await store.transitionResourceOperationRun({
          id: initial.id,
          operationKey: initial.resourceOperationKey,
          expectedVersion: 2,
          expectFrom: ["running"],
          run: substituted,
        })
      ).won,
    ).toBe(false);
    expect(await store.getResourceOperationRun(initial.id)).toEqual(withResult);
  }
});

test("direct Resource Runs are readable through the canonical public Run facade without being misread as PlanRun/ApplyRun", async () => {
  const operations = [
    ["artifact", "artifact"],
    ["preview", "plan"],
    ["apply", "apply"],
    ["import", "apply"],
    ["observe", "drift_check"],
    ["refresh", "apply"],
    ["delete", "destroy_apply"],
  ] as const;

  for (const [, store] of await stores()) {
    const query = new RunQueryService(store);
    for (const [resourceOperation, type] of operations) {
      const run = resourceRun({
        id: `run_resource_${resourceOperation}assets`,
        resourceOperation,
        resourceOperationKey: `sha256:${resourceOperation}-assets-v1`,
        type,
      });
      await store.beginResourceOperationRun(run);
      const internalWithEvidence: ResourceOperationRun = {
        ...run,
        resourceOperationVersion: 2,
        resourceOperationResult: {
          summary: `${resourceOperation} completed`,
          nativeResources: [{ type: "r2_bucket", id: "bucket-assets" }],
          outputs: { private_internal_value: "must-not-project" },
          ...(resourceOperation === "observe"
            ? { observationStatus: "current" as const }
            : {}),
        },
        resourceOperationAudit: {
          status: "pending",
          eventId: `act_${run.id}`,
          action: `resource.${resourceOperation}.succeeded`,
          metadata: {
            generation: 1,
            private_internal_value: "must-not-project",
          },
          createdAt: CREATED_AT,
        },
      };
      expect(
        (
          await store.transitionResourceOperationRun({
            id: run.id,
            operationKey: run.resourceOperationKey,
            expectedVersion: 1,
            expectFrom: ["running"],
            run: internalWithEvidence,
          })
        ).won,
      ).toBe(true);

      // Physical runs.type intentionally overlaps. Typed getters must inspect
      // the JSON shape instead of casting this direct Resource Run.
      expect(await store.getPlanRun(run.id)).toBeUndefined();
      expect(await store.getApplyRun(run.id)).toBeUndefined();

      const publicRun = await query.getRun(run.id);
      expect(publicRun).toEqual({
        id: run.id,
        workspaceId: run.workspaceId,
        subject: run.subject,
        resourceOperation,
        type,
        status: "running",
        createdBy: run.createdBy,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
      });
      expect("resourceOperationKey" in publicRun).toBe(false);
      expect("resourceOperationVersion" in publicRun).toBe(false);
      expect("resourceOperationResult" in publicRun).toBe(false);
      expect("resourceOperationAudit" in publicRun).toBe(false);
      expect(await query.getRunLogs(run.id)).toEqual({
        diagnostics: [],
        auditEvents: [],
      });
      expect(await query.getRunEvents(run.id)).toEqual({ auditEvents: [] });
      await expect(query.getRunCost(run.id)).rejects.toThrow(
        "cost not available",
      );
    }

    const listed = await query.listRuns("space_a");
    expect(listed).toHaveLength(operations.length);
    for (const run of listed) {
      expect(run.resourceOperation).toBeDefined();
      expect("resourceOperationKey" in run).toBe(false);
      expect("resourceOperationResult" in run).toBe(false);
      expect("resourceOperationAudit" in run).toBe(false);
    }
  }
});
