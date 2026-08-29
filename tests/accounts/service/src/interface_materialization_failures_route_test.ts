import { expect, test } from "bun:test";

import { handleWorkspaces } from "../../../../accounts/service/src/control/workspaces.ts";

const FAILURE_DIGEST = `sha256:${"1".repeat(64)}`;
const BLUEPRINTS_DIGEST = `sha256:${"2".repeat(64)}`;

function operations(overrides: {
  readonly ownerUserId?: string;
  readonly retryCalls?: unknown[];
}) {
  return {
    workspaces: {
      getWorkspace: () =>
        Promise.resolve({
          id: "workspace_interface_failures",
          ownerUserId: overrides.ownerUserId ?? "account_owner",
        }),
    },
    members: {
      getMember: () =>
        Promise.resolve({
          workspaceId: "workspace_interface_failures",
          accountId: "account_viewer",
          roles: ["viewer"],
          status: "active",
        }),
    },
    listInterfaceMaterializationFailures: () =>
      Promise.resolve([
        {
          id: "cimi_failure",
          capsuleId: "capsule_failure",
          stateVersionId: "state_failure",
          outputId: "output_failure",
          stateGeneration: 3,
          blueprintsDigest: BLUEPRINTS_DIGEST,
          totalItems: 4,
          nextItemIndex: 2,
          attempts: 1,
          error: {
            code: "interface_provenance_conflict",
            detailDigest: `sha256:${"3".repeat(64)}`,
            recordedAt: "2026-08-29T12:00:00.000Z",
          },
          deadLetteredAt: "2026-08-29T12:00:00.000Z",
          failureDigest: FAILURE_DIGEST,
        },
      ]),
    retryInterfaceMaterializationFailure: (
      workspaceId: string,
      intentId: string,
      input: unknown,
    ) => {
      overrides.retryCalls?.push({ workspaceId, intentId, input });
      return Promise.resolve({
        id: intentId,
        capsuleId: "capsule_failure",
        stateVersionId: "state_failure",
        stateGeneration: 3,
        blueprintsDigest: BLUEPRINTS_DIGEST,
        status: "pending" as const,
        nextItemIndex: 2,
        totalItems: 4,
        nextRetryAt: "2026-08-29T12:01:00.000Z",
      });
    },
  };
}

async function request(input: {
  readonly method: "GET" | "POST";
  readonly segments: readonly string[];
  readonly subject?: string;
  readonly operations: unknown;
  readonly body?: unknown;
}): Promise<Response | undefined> {
  const url = new URL(
    `https://app.example.test/api/v1/${input.segments.join("/")}`,
  );
  const request = new Request(url, {
    method: input.method,
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
  });
  return await handleWorkspaces(
    {
      request,
      url,
      operations: input.operations,
      store: {},
      session: {
        subject: input.subject ?? "account_owner",
        requiredAccess: input.method === "GET" ? "read" : "write",
      },
    } as never,
    input.segments,
    input.method,
  );
}

test("Workspace members read only value-free Interface materialization failures", async () => {
  const response = await request({
    method: "GET",
    segments: [
      "workspaces",
      "workspace_interface_failures",
      "interface-materialization-failures",
    ],
    operations: operations({}),
  });
  expect(response?.status).toBe(200);
  const payload = await response!.json();
  expect(payload).toMatchObject({
    failures: [{ id: "cimi_failure", failureDigest: FAILURE_DIGEST }],
  });
  expect(JSON.stringify(payload)).not.toContain('"blueprints":');
});

test("only a Workspace writer can submit the exact DLQ retry CAS", async () => {
  const retryCalls: unknown[] = [];
  const segments = [
    "workspaces",
    "workspace_interface_failures",
    "interface-materialization-failures",
    "cimi_failure",
    "retries",
  ];
  const body = {
    failureDigest: FAILURE_DIGEST,
    stateVersionId: "state_failure",
    stateGeneration: 3,
  };
  const accepted = await request({
    method: "POST",
    segments,
    operations: operations({ retryCalls }),
    body,
  });
  expect(accepted?.status).toBe(200);
  expect(retryCalls).toEqual([
    {
      workspaceId: "workspace_interface_failures",
      intentId: "cimi_failure",
      input: body,
    },
  ]);

  const forbiddenCalls: unknown[] = [];
  const forbidden = await request({
    method: "POST",
    segments,
    subject: "account_viewer",
    operations: operations({
      ownerUserId: "account_owner",
      retryCalls: forbiddenCalls,
    }),
    body,
  });
  expect(forbidden?.status).toBe(403);
  expect(forbiddenCalls).toEqual([]);
});
