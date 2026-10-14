import { expect, test } from "bun:test";
import { validateUninstallRequester } from "../../../../accounts/service/src/uninstall-requester.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { CapsulesService } from "../../../../core/domains/capsules/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import type { UninstallRequesterAtValidator } from "../../../../core/domains/capsules/uninstall_authorization.ts";

const dayMs = 86_400_000;
const nowMs = Date.now() + 60_000;
const patSecret = "fixture-uninstall-pat-expiry-secret";
const patId = "fixture-pat-expiry";
const subject = "tsub_uninstall_expiry";

type DeadlineValidator = UninstallRequesterAtValidator;

function serviceWithDeadlineValidator(
  store: InMemoryOpenTofuControlStore,
  validateUninstallRequesterAt: DeadlineValidator | null,
  options: { graceDays?: number; activity?: { record: (event: unknown) => Promise<void> } } = {},
): CapsulesService {
  const dependencies = {
    store,
    now: () => new Date(nowMs),
    newId: (prefix: string) => `${prefix}_fixed`,
    uninstallGraceDays: options.graceDays ?? 7,
    ...(options.activity ? { activity: options.activity } : {}),
    ...(validateUninstallRequesterAt === null ? {} : { validateUninstallRequesterAt }),
  };
  return new CapsulesService(dependencies);
}

async function fixture(options: {
  expiresAt?: number;
  graceDays?: number;
  validator?: DeadlineValidator | null;
  credential?: "pat" | "session";
} = {}) {
  const controlStore = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(controlStore);
  await controlStore.putCapsule({
    ...seeded.capsule,
    status: "active",
    currentStateGeneration: 1,
  });
  await controlStore.putWorkspace({ ...seeded.workspace, ownerUserId: subject });
  const accounts = new InMemoryAccountsStore();
  accounts.saveAccount({ subject, createdAt: nowMs, updatedAt: nowMs });
  const credential = options.credential ?? "pat";
  if (credential === "pat") {
    accounts.savePersonalAccessToken(patSecret, {
      tokenId: patId,
      tokenPrefix: "fixture",
      subject,
      name: "uninstall",
      scopes: ["write"],
      workspaceId: seeded.workspace.id,
      createdAt: nowMs,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    });
  } else {
    accounts.saveAccountSession({
      sessionId: patSecret,
      subject,
      createdAt: nowMs,
      expiresAt: nowMs + 5 * 60_000,
    });
  }
  const activity: unknown[] = [];
  const validator = options.validator === undefined
    ? accountsDeadlineValidator(accounts)
    : options.validator;
  const capsules = serviceWithDeadlineValidator(
    controlStore,
    validator,
    {
      graceDays: options.graceDays,
      activity: { record: async (event) => { activity.push(event); } },
    },
  );
  const operations = {
    capsules,
    workspaces: new WorkspacesService({ store: controlStore }),
    members: { listMembers: async () => [] },
  } as unknown as ControlPlaneOperations;
  const url = new URL(`https://example.test/api/v1/capsules/${seeded.capsule.id}/uninstall`);
  const request = new Request(url, {
    method: "POST",
    headers: { authorization: `Bearer ${patSecret}` },
  });
  return {
    controlStore,
    seeded,
    accounts,
    activity,
    capsules,
    operations,
    url,
    request,
    subject,
    credential,
  };
}

function accountsDeadlineValidator(accounts: InMemoryAccountsStore): DeadlineValidator {
  return (requester, workspaceId, validAtMs) =>
    validateUninstallRequester(accounts, requester, workspaceId, validAtMs);
}

async function publicUninstall(state: Awaited<ReturnType<typeof fixture>>) {
  return handleControlRoute({
    request: state.request,
    url: state.url,
    store: state.accounts,
    operations: state.operations,
  });
}

test("public uninstall rejects a PAT expiring at the scheduled finalization deadline without side effects", async () => {
  const deadline = nowMs + 7 * dayMs;
  const state = await fixture({ expiresAt: deadline });
  const before = await state.controlStore.getCapsule(state.seeded.capsule.id);

  const response = await publicUninstall(state);

  expect(response?.status).toBe(409);
  const body = await response!.json();
  expect(body).toMatchObject({ error: {
    code: "failed_precondition",
    details: { reason: "capsule_uninstall_pat_deadline_unverified" },
  } });
  expect(body.error.message).toContain("session");
  expect(body.error.message).toContain("PAT");
  expect(body.error.message).toContain("finalization");
  expect(await state.controlStore.getCapsule(state.seeded.capsule.id)).toEqual(before);
  expect(await state.controlStore.listActivityEvents(state.seeded.workspace.id, { limit: 100 })).toHaveLength(0);
  expect(state.activity).toHaveLength(0);
});

test("public uninstall checks the exact scheduled deadline and accepts later or non-expiring PATs", async () => {
  const deadline = nowMs + 7 * dayMs;
  for (const [label, expiresAt] of [
    ["one millisecond after deadline", deadline + 1],
    ["no expiry", undefined],
  ] as const) {
    const checks: number[] = [];
    const validationResults: boolean[] = [];
    const state = await fixture({
      expiresAt,
      validator: async (_requester, workspaceId, validAtMs) => {
        expect(workspaceId).toBe(stateWorkspaceId);
        checks.push(validAtMs);
        const valid = await accountsDeadlineValidator(state.accounts)(_requester, workspaceId, validAtMs);
        validationResults.push(valid);
        return valid;
      },
    });
    const stateWorkspaceId = state.seeded.workspace.id;

    const response = await publicUninstall(state);

    expect(validationResults, label).toEqual([true]);
    expect(response?.status, label).toBe(202);
    expect(checks).toEqual([deadline]);
    expect((await state.controlStore.getCapsule(state.seeded.capsule.id))?.uninstall?.scheduledDestroyAt)
      .toBe(new Date(deadline).toISOString());
  }
});

test("public uninstall rejects a PAT expiring just before the scheduled deadline", async () => {
  const deadline = nowMs + 7 * dayMs;
  const state = await fixture({ expiresAt: deadline - 1 });

  const response = await publicUninstall(state);

  expect(response?.status).toBe(409);
  expect((await response!.json()).error.details.reason)
    .toBe("capsule_uninstall_pat_deadline_unverified");
});

test("session requester schedules without consulting the PAT deadline validator", async () => {
  const state = await fixture({
    credential: "session",
    validator: async () => { throw new Error("session must not be checked as a PAT"); },
  });

  const response = await publicUninstall(state);

  expect(response?.status).toBe(202);
  expect((await state.controlStore.getCapsule(state.seeded.capsule.id))?.uninstall?.requester)
    .toEqual({ subject: state.subject });
});

test("Core admission fails closed for missing, false, and throwing deadline checks without leaking errors", async () => {
  const cases: Array<{ label: string; validator?: DeadlineValidator | null }> = [
    { label: "missing", validator: null },
    { label: "false", validator: async () => false },
    { label: "throws", validator: async () => { throw new Error("private lookup secret"); } },
  ];

  for (const { label, validator } of cases) {
    const state = await fixture({
      validator,
      expiresAt: nowMs + 7 * dayMs + 1,
    });
    const before = await state.controlStore.getCapsule(state.seeded.capsule.id);

    const response = await publicUninstall(state);
    const body = await response!.json();

    expect(response?.status, label).toBe(409);
    expect(body).toMatchObject({ error: {
      code: "failed_precondition",
      details: { reason: "capsule_uninstall_pat_deadline_unverified" },
    } });
    expect(body.error.message).toContain("session");
    expect(body.error.message).toContain("PAT");
    expect(body.error.message).toContain("finalization");
    expect(JSON.stringify(body)).not.toContain("private lookup secret");
    expect(JSON.stringify(body)).not.toContain(patSecret);
    expect(await state.controlStore.getCapsule(state.seeded.capsule.id)).toEqual(before);
    expect(await state.controlStore.listActivityEvents(state.seeded.workspace.id, { limit: 100 })).toHaveLength(0);
    expect(state.activity).toHaveLength(0);
  }
});

test("direct Core scheduling rejects unverified PAT deadlines before saving a reservation", async () => {
  for (const validator of [
    null,
    async () => false,
    async () => { throw new Error("private lookup secret"); },
  ] as const) {
    const state = await fixture({ validator, expiresAt: nowMs + 7 * dayMs + 1 });
    const before = await state.controlStore.getCapsule(state.seeded.capsule.id);
    let caught: unknown;
    try {
      await state.capsules.scheduleCapsuleUninstall(state.seeded.capsule.id, {
        actor: state.subject,
        requester: {
          subject: state.subject,
          grant: { kind: "personal-access-token", tokenId: patId },
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenTofuControllerError);
    expect(caught).toMatchObject({
      code: "failed_precondition",
      details: { reason: "capsule_uninstall_pat_deadline_unverified" },
    });
    expect((caught as Error).message).toContain("session");
    expect((caught as Error).message).toContain("PAT");
    expect((caught as Error).message).toContain("finalization");
    expect(String(caught)).not.toContain("private lookup secret");
    expect(await state.controlStore.getCapsule(state.seeded.capsule.id)).toEqual(before);
    expect(state.activity).toHaveLength(0);
  }
});

test("zero grace still rejects a PAT expiring at the immediate finalization deadline", async () => {
  const state = await fixture({
    graceDays: 0,
    expiresAt: nowMs,
  });
  const before = await state.controlStore.getCapsule(state.seeded.capsule.id);

  const response = await publicUninstall(state);

  expect(response?.status).toBe(409);
  expect((await response!.json()).error.details.reason)
    .toBe("capsule_uninstall_pat_deadline_unverified");
  expect(await state.controlStore.getCapsule(state.seeded.capsule.id)).toEqual(before);
  expect(state.activity).toHaveLength(0);
});

test("replaying an already scheduled uninstall does not recheck the PAT deadline", async () => {
  let valid = true;
  let checks = 0;
  const state = await fixture({
    expiresAt: nowMs + 7 * dayMs + 1,
    validator: async (requester, workspaceId, validAtMs) => {
      checks += 1;
      return valid && validateUninstallRequester(state.accounts, requester, workspaceId, validAtMs);
    },
  });

  const first = await publicUninstall(state);
  expect(first?.status).toBe(202);
  const scheduled = await state.controlStore.getCapsule(state.seeded.capsule.id);
  valid = false;

  const second = await publicUninstall(state);

  expect(second?.status).toBe(202);
  expect(await state.controlStore.getCapsule(state.seeded.capsule.id)).toEqual(scheduled);
  expect(checks).toBe(1);
  expect(state.activity).toHaveLength(1);
});
