import { expect, test } from "bun:test";

import {
  type ControlPlaneOperations,
  handleControlRoute,
  isControlRoutePath,
} from "../../../../accounts/service/src/control-routes.ts";
import {
  maybeEnsurePersonalWorkspaceForSession,
  personalWorkspaceHandle,
} from "../../../../accounts/service/src/control-personal-space.ts";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";

// --- Test harness ----------------------------------------------------------

const ORIGIN = "https://app.takosumi.test";

/** A live account + session in a fresh store. Returns the cookie header value. */
function seedSession(
  store: InMemoryAccountsStore,
  options: { subject?: string; email?: string; displayName?: string } = {},
): { sessionId: string; cookie: string; subject: string } {
  const subject = options.subject ?? "tsub_ctrl";
  const now = Date.now();
  store.saveAccount({
    subject,
    createdAt: now,
    updatedAt: now,
    ...(options.email ? { email: options.email } : {}),
    ...(options.displayName ? { displayName: options.displayName } : {}),
  });
  const sessionId = "sess_ctrl_ok";
  store.saveAccountSession({
    sessionId,
    subject,
    createdAt: now,
    expiresAt: now + 60_000,
  });
  return {
    sessionId,
    cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}`,
    subject,
  };
}

function seedPersonalAccessToken(
  store: InMemoryAccountsStore,
  input: {
    token: string;
    subject?: string;
    scopes?: readonly ("read" | "write" | "admin")[];
  },
): void {
  const subject = input.subject ?? "tsub_ctrl";
  const now = Date.now();
  store.saveAccount({
    subject,
    createdAt: now,
    updatedAt: now,
  });
  store.savePersonalAccessToken(input.token, {
    tokenId: `pat_${input.token.slice("takpat_".length)}`,
    tokenPrefix: input.token.slice(0, "takpat_".length + 8),
    subject,
    name: "Test automation",
    scopes: input.scopes ?? ["read", "write"],
    createdAt: now,
  });
}

function seedLedgerWorkspace(
  store: InMemoryAccountsStore,
  input: { subject: string; accountId: string; workspaceId: string },
): void {
  const now = Date.now();
  store.saveLedgerAccount({
    accountId: input.accountId,
    legalOwnerSubject: input.subject,
    createdAt: now,
    updatedAt: now,
  });
  store.saveWorkspace({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    kind: "personal",
    createdAt: now,
    updatedAt: now,
  });
}

/** A spy-able fake facade. Records the last call args for assertions. */
type ControlPlaneOperationsOverride = Partial<
  Omit<ControlPlaneOperations, "spaces">
> & {
  readonly spaces?: Partial<ControlPlaneOperations["spaces"]>;
};

function fakeOperations(
  overrides: ControlPlaneOperationsOverride = {},
): ControlPlaneOperations & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, ...args: unknown[]) => {
    calls[name] = args;
  };
  const space = (id: string) => ({
    id,
    handle: "shota",
    displayName: "Shota",
    type: "personal" as const,
    ownerUserId: "tsub_ctrl",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  const installation = (id: string, workspaceId: string) => ({
    id,
    workspaceId,
    name: "app",
    slug: "app",
    sourceId: "src_x",
    installType: "opentofu_module" as const,
    installConfigId: "cfg_x",
    environment: "prod",
    currentOutputId: "osnap_secret_1",
    currentStateGeneration: 0,
    status: "ready" as const,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  const base: ControlPlaneOperations = {
    spaces: {
      listWorkspaces: async () => {
        record("listWorkspaces");
        return [space("space_a")];
      },
      listWorkspacesByOwner: async (ownerUserId) => {
        record("listWorkspacesByOwner", ownerUserId);
        // The fixture Workspace is owned by `tsub_ctrl`; other subjects own none
        // directly (they reach Workspaces only via the ledger legal-owner branch).
        return ownerUserId === "tsub_ctrl" ? [space("space_a")] : [];
      },
      getWorkspace: async (id) => {
        record("getWorkspace", id);
        return space(id);
      },
      createWorkspace: async (req) => {
        record("createWorkspace", req);
        return { ...space("space_new"), handle: req.handle, type: req.type };
      },
      updateWorkspace: async (id, patch) => {
        record("updateWorkspace", id, patch);
        const baseWorkspace = space(id);
        return {
          ...baseWorkspace,
          ...(patch.displayName ? { displayName: patch.displayName } : {}),
          ...(patch.policy ? { policy: patch.policy } : {}),
          ...(patch.archived === true
            ? { archivedAt: "2026-01-02T00:00:00Z" }
            : {}),
          updatedAt: "2026-01-02T00:00:00Z",
        };
      },
    },
    installations: {
      getCapsule: async (id) => {
        record("getCapsule", id);
        return installation(id, "space_a");
      },
      listCapsules: async (workspaceId) => {
        record("listCapsules", workspaceId);
        return [installation("inst_1", workspaceId)];
      },
      listCapsulesPage: async (workspaceId, params) => {
        record("listCapsulesPage", workspaceId, params);
        return { items: [installation("inst_1", workspaceId)] };
      },
      createCapsule: async (req) => {
        record("createCapsule", req);
        return installation("inst_new", req.workspaceId);
      },
      putInstallConfig: async (config) => {
        record("putInstallConfig", config);
        return config;
      },
      getInstallConfig: async (id) => {
        record("getInstallConfig", id);
        return {
          id,
          name: "opentofu-capsule",
          sourceKind: "generic_capsule",
          installType: "opentofu_module",
          trustLevel: "trusted",
          variableMapping: {},
          outputAllowlist: {},
          policy: {},
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        };
      },
      listInstallConfigs: async (workspaceId) => {
        record("listInstallConfigs", workspaceId);
        return [];
      },
      patchCapsuleStatus: async (id, status) => {
        record("patchCapsuleStatus", id, status);
        return { ...installation(id, "space_a"), status };
      },
      putCapsuleProviderEnvBindingSet: async (profile) => {
        record("putCapsuleProviderEnvBindingSet", profile);
        return profile;
      },
      getCapsuleProviderEnvBindingSetByCapsule: async (
        capsuleId,
        environment,
      ) => {
        record(
          "getCapsuleProviderEnvBindingSetByCapsule",
          capsuleId,
          environment,
        );
        return {
          id: "dpf_1",
          workspaceId: "space_a",
          capsuleId,
          environment,
          bindings: [
            {
              provider: "cloudflare",
              alias: "main",
              connectionId: "conn_cf_gateway",
            },
          ],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        };
      },
    },
    dependencies: {
      createDependency: async (req) => {
        record("createDependency", req);
        return {
          id: "dep_1",
          workspaceId: req.workspaceId,
          producerCapsuleId: req.producerCapsuleId,
          consumerCapsuleId: req.consumerCapsuleId,
          mode: req.mode,
          outputs: req.outputs,
          visibility: req.visibility,
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      getDependency: async (id) => {
        record("getDependency", id);
        return {
          id,
          workspaceId: "space_a",
          producerCapsuleId: "inst_1",
          consumerCapsuleId: "inst_2",
          mode: "variable_injection",
          outputs: {},
          visibility: "space",
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      listForCapsule: async (capsuleId) => {
        record("listForCapsule", capsuleId);
        return {
          asProducer: [
            {
              id: "dep_downstream",
              workspaceId: "space_a",
              producerCapsuleId: capsuleId,
              consumerCapsuleId: "inst_consumer",
              mode: "variable_injection",
              outputs: {},
              visibility: "space",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
          asConsumer: [],
        };
      },
      deleteDependency: async (id) => {
        record("deleteDependency", id);
        return true;
      },
    },
    listDependenciesByWorkspace: async (workspaceId) => {
      record("listDependenciesByWorkspace", workspaceId);
      return [
        {
          id: "dep_1",
          workspaceId,
          producerCapsuleId: "inst_1",
          consumerCapsuleId: "inst_2",
          mode: "variable_injection",
          outputs: { db_url: { from: "url", to: "db_url", required: true } },
          visibility: "space",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ];
    },
    runGroups: {
      createWorkspaceUpdate: async (workspaceId) => {
        record("createWorkspaceUpdate", workspaceId);
        return { runGroup: { id: "rg_1", workspaceId }, runs: [] };
      },
      createWorkspaceDriftCheck: async (workspaceId, options) => {
        record("createWorkspaceDriftCheck", workspaceId, options);
        return {
          runGroup: { id: "rg_drift", workspaceId, type: "space_drift_check" },
          runs: [],
        };
      },
      getRunGroup: async (id) => {
        record("getRunGroup", id);
        return { runGroup: { id, workspaceId: "space_a" }, runs: [] };
      },
      approveRunGroup: async (id) => {
        record("approveRunGroup", id);
        return { runGroup: { id, workspaceId: "space_a" }, runs: [] };
      },
    },
    activity: {
      record: async (event) => {
        record("activityRecord", event);
        return {
          ...event,
          id: "act_1",
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      list: async (workspaceId, limit) => {
        record("activityList", workspaceId, limit);
        return [];
      },
    },
    backups: {
      createBackup: async (input) => {
        record("createBackup", input);
        return {
          id: "bkp_1",
          workspaceId: input.workspaceId,
          objectKey: `spaces/${input.workspaceId}/backups/bkp_1/control.json.zst.enc`,
          digest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sizeBytes: 128,
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      listBackups: async (workspaceId) => {
        record("listBackups", workspaceId);
        return {
          backups: [
            {
              id: "bkp_1",
              workspaceId,
              objectKey: `spaces/${workspaceId}/backups/bkp_1/control.json.zst.enc`,
              digest:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              sizeBytes: 128,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        };
      },
    },
    createRestoreRun: async (workspaceId, backupId, request, context) => {
      record("createRestoreRun", workspaceId, backupId, request, context);
      return {
        id: "restore_1",
        workspaceId,
        type: "restore",
        status: "waiting_approval",
        backupId,
        restoreStateGeneration: request.stateGeneration,
        createdAt: "2026-01-01T00:00:00Z",
      } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["createRestoreRun"]>
      >;
    },
    recordUploadArchive: async (input) => {
      record("recordUploadArchive", {
        ...input,
        bytes: Array.from(input.bytes),
      });
      return {
        id: "snap_upload",
        origin: "upload",
        workspaceId: input.workspaceId,
        url: `https://uploads.takosumi.com/${input.workspaceId}`,
        ref: "upload",
        resolvedCommit:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        path: input.path ?? ".",
        archiveObjectKey: `spaces/${input.workspaceId}/uploads/snap_upload/source.tar.zst`,
        archiveDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        archiveSizeBytes: input.bytes.byteLength,
        fetchedByRunId: "upload",
        fetchedAt: "2026-01-01T00:00:00Z",
      };
    },
    recordArtifactSnapshot: async (input) => {
      record("recordArtifactSnapshot", input);
      return {
        id: "snap_artifact",
        origin: "artifact",
        workspaceId: input.workspaceId,
        url: input.url,
        ref: "artifact",
        resolvedCommit:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        path: input.path ?? ".",
        archiveObjectKey: `spaces/${input.workspaceId}/artifact-snapshots/snap_artifact/source.tar.zst`,
        archiveDigest: input.digest,
        archiveSizeBytes: 128,
        fetchedByRunId: "artifact",
        fetchedAt: "2026-01-01T00:00:00Z",
      };
    },
    getSourceSnapshot: async (id) => {
      record("getSourceSnapshot", id);
      return {
        id,
        origin: "upload",
        workspaceId: "space_a",
        url: "upload://space_a",
        ref: "upload",
        resolvedCommit:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        path: ".",
        archiveObjectKey: `spaces/space_a/uploads/${id}/source.tar.zst`,
        archiveDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        archiveSizeBytes: 128,
        fetchedByRunId: "upload",
        fetchedAt: "2026-01-01T00:00:00Z",
      };
    },
    deployUpload: async (req) => {
      record("deployUpload", req);
      return {
        installation: {
          id: "inst_upload",
          workspaceId: req.workspaceId,
          name: req.name,
          slug: req.name,
          installConfigId: "cfg_upload",
          environment: req.environment ?? "production",
          currentStateGeneration: 0,
          status: "ready",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        installConfigId: "cfg_upload",
        run: {
          id: "plan_upload",
          workspaceId: req.workspaceId,
          capsuleId: "inst_upload",
          type: "plan",
          status: "succeeded",
          sourceSnapshotId: req.snapshotId,
          planDigest: `sha256:${"d".repeat(64)}`,
          createdBy: "test",
          createdAt: "2026-01-01T00:00:00Z",
        },
        status: "planned",
        created: true,
      };
    },
    getWorkspaceBilling: async (workspaceId) => {
      record("getWorkspaceBilling", workspaceId);
      return {
        billing: {
          settings: { mode: "showback", provider: "manual" },
          balance: {
            workspaceId,
            availableCredits: 120,
            reservedCredits: 8,
            monthlyIncludedCredits: 100,
            purchasedCredits: 20,
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
      };
    },
    listWorkspaceUsage: async (workspaceId) => {
      record("listWorkspaceUsage", workspaceId);
      return {
        usageEvents: [
          {
            id: "use_1",
            workspaceId,
            kind: "runner_minute",
            quantity: 2,
            credits: 3,
            source: "runner",
            idempotencyKey: "idem_1",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      };
    },
    listWorkspaceCreditReservations: async (workspaceId) => {
      record("listWorkspaceCreditReservations", workspaceId);
      return {
        creditReservations: [
          {
            id: "cres_1",
            workspaceId,
            runId: "plan_1",
            estimatedCredits: 28,
            status: "reserved",
            mode: "enforce",
            createdAt: "2026-01-01T00:00:00Z",
            expiresAt: "2026-01-01T01:00:00Z",
          },
        ],
      };
    },
    topUpWorkspaceCredits: async (workspaceId, input) => {
      record("topUpWorkspaceCredits", workspaceId, input);
      return {
        balance: {
          workspaceId,
          availableCredits: input.credits,
          reservedCredits: 0,
          monthlyIncludedCredits: 0,
          purchasedCredits: input.credits,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      };
    },
    changeWorkspaceSubscription: async (workspaceId, input) => {
      record("changeWorkspaceSubscription", workspaceId, input);
      return { billing: { settings: input.billingSettings } };
    },
    connections: {
      listProviderConnections: async () => {
        record("listProviderConnections");
        return [];
      },
    },
    outputShares: {
      createShare: async (req) => {
        record("createOutputShare", req);
        return {
          id: "oshare_1",
          fromWorkspaceId: req.fromWorkspaceId,
          toWorkspaceId: req.toWorkspaceId,
          producerCapsuleId: req.producerCapsuleId,
          outputs: req.outputs.map((output) => ({
            name: output.name,
            ...(output.alias ? { alias: output.alias } : {}),
            sensitive: output.sensitive === true,
          })),
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      listForWorkspace: async (workspaceId) => {
        record("listOutputShares", workspaceId);
        return [
          {
            id: "oshare_1",
            fromWorkspaceId: workspaceId,
            toWorkspaceId: "space_b",
            producerCapsuleId: "inst_1",
            outputs: [{ name: "domain", sensitive: false }],
            status: "active",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ];
      },
      listForWorkspacePage: async (workspaceId) => {
        record("listOutputShares", workspaceId);
        return {
          items: [
            {
              id: "oshare_1",
              fromWorkspaceId: workspaceId,
              toWorkspaceId: "space_b",
              producerCapsuleId: "inst_1",
              outputs: [{ name: "domain", sensitive: false }],
              status: "active",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        };
      },
      getShare: async (id) => {
        record("getOutputShare", id);
        return {
          id,
          fromWorkspaceId: "space_a",
          toWorkspaceId: "space_b",
          producerCapsuleId: "inst_1",
          outputs: [{ name: "domain", sensitive: false }],
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      approveShare: async (id) => {
        record("approveOutputShare", id);
        return {
          id,
          fromWorkspaceId: "space_a",
          toWorkspaceId: "space_b",
          producerCapsuleId: "inst_1",
          outputs: [{ name: "domain", sensitive: false }],
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      revokeShare: async (id) => {
        record("revokeOutputShare", id);
        return {
          id,
          fromWorkspaceId: "space_a",
          toWorkspaceId: "space_b",
          producerCapsuleId: "inst_1",
          outputs: [{ name: "domain", sensitive: false }],
          status: "revoked",
          createdAt: "2026-01-01T00:00:00Z",
          revokedAt: "2026-01-01T00:01:00Z",
        };
      },
    },
    listConnections: async (workspaceId) => {
      record("listConnections", workspaceId);
      return { connections: [] };
    },
    listOperatorConnections: async () => {
      record("listOperatorConnections");
      return { connections: [] };
    },
    getConnection: async (connectionId) => {
      record("getConnection", connectionId);
      return {
        id: connectionId,
        workspaceId: "space_a",
        provider: "cloudflare",
        kind: "cloudflare_api_token",
        authMethod: "static_secret",
        scope: "space",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["getConnection"]>
      >;
    },
    createConnection: async (request) => {
      record("createConnection", request);
      return {
        connection: {
          id: "conn_new",
          workspaceId: request.workspaceId ?? "space_a",
          provider: request.provider,
          kind: request.kind ?? "generic_env_provider",
          authMethod: request.authMethod,
          scope: request.scope ?? "space",
          status: "pending",
          // The public projection NEVER carries secret `values`.
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["createConnection"]>
      >;
    },
    testConnection: async (connectionId) => {
      record("testConnection", connectionId);
      return { status: "verified" } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["testConnection"]>
      >;
    },
    revokeConnection: async (connectionId) => {
      record("revokeConnection", connectionId);
    },
    createCapsulePlan: async (capsuleId, options) => {
      record("createCapsulePlan", { capsuleId, options });
      return { planRun: { id: "plan_1" } } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["createCapsulePlan"]>
      >;
    },
    createCapsuleDestroyPlan: async (capsuleId, options) => {
      record("createCapsuleDestroyPlan", { capsuleId, options });
      return { planRun: { id: "plan_destroy" } } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["createCapsuleDestroyPlan"]>
      >;
    },
    createCapsuleDriftCheck: async (capsuleId) => {
      record("createCapsuleDriftCheck", capsuleId);
      return { planRun: { id: "plan_drift" } } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["createCapsuleDriftCheck"]>
      >;
    },
    getRun: async (id) => {
      record("getRun", id);
      return {
        id,
        workspaceId: "space_a",
        type: "plan",
        status: "succeeded",
        createdBy: "test",
        createdAt: "2026-01-01T00:00:00Z",
      } as unknown as Awaited<ReturnType<ControlPlaneOperations["getRun"]>>;
    },
    listRuns: async (workspaceId, options) => {
      record("listRuns", workspaceId, options);
      return [
        {
          id: "apply_1",
          workspaceId,
          capsuleId: "inst_1",
          type: "apply",
          status: "succeeded",
          createdBy: "test",
          createdAt: "2026-01-01T00:01:00Z",
        },
        {
          id: "plan_1",
          workspaceId,
          capsuleId: "inst_1",
          type: "plan",
          status: "waiting_approval",
          createdBy: "test",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ] as unknown as Awaited<ReturnType<ControlPlaneOperations["listRuns"]>>;
    },
    approveRun: async (id, input) => {
      record("approveRun", id, input);
      return {
        id,
        workspaceId: "space_a",
        status: "queued",
      } as unknown as Awaited<ReturnType<ControlPlaneOperations["approveRun"]>>;
    },
    cancelRun: async (id) => {
      record("cancelRun", id);
      return {
        id,
        workspaceId: "space_a",
        status: "canceled",
      } as unknown as Awaited<ReturnType<ControlPlaneOperations["cancelRun"]>>;
    },
    getRunLogs: async (id) => {
      record("getRunLogs", id);
      return { diagnostics: [], auditEvents: [] };
    },
    getRunEvents: async (id) => {
      record("getRunEvents", id);
      return { auditEvents: [] };
    },
    getRunCost: async (id) => {
      record("getRunCost", id);
      return {
        runId: id,
        billingMode: "enforce",
        estimatedUsdMicros: 12_000_000,
        availableUsdMicros: 5_000_000,
        shortfallUsdMicros: 7_000_000,
        estimatedCredits: 12,
        availableCredits: 5,
        reservationStatus: "insufficient_credits",
        creditShortfall: 7,
        blocked: true,
        reasons: [
          "credit reservation failed: 12 credits estimated but only 5 available",
        ],
      };
    },
    getPlanRun: async (id) => {
      record("getPlanRun", id);
      return {
        planRun: {
          id,
          workspaceId: "space_a",
          capsuleId: "inst_upload",
          sourceSnapshotId: "snap_upload",
          status: "succeeded",
          operation: "create",
          source: {
            kind: "git",
            url: "upload://space_a",
            commit:
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          runnerProfileId: "rp_default",
          sourceDigest: `sha256:${"a".repeat(64)}`,
          variablesDigest: `sha256:${"b".repeat(64)}`,
          policyDecisionDigest: `sha256:${"c".repeat(64)}`,
          policy: { status: "passed" },
          planDigest: `sha256:${"d".repeat(64)}`,
          planArtifact: { kind: "object-storage", ref: "k", digest: "e" },
          resolvedProviderEnvBindingsDigest: `sha256:${"f".repeat(64)}`,
        },
      } as unknown as Awaited<ReturnType<ControlPlaneOperations["getPlanRun"]>>;
    },
    createApplyRun: async (req) => {
      record("createApplyRun", req);
      return {
        applyRun: {
          id: "apply_1",
          planRunId: req.planRunId,
          workspaceId: "space_a",
          status: "queued",
        },
      } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["createApplyRun"]>
      >;
    },
    createSource: async (req) => {
      record("createSource", req);
      return {
        source: { id: "src_new" },
        hookSecret: "hk_x",
      } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["createSource"]>
      >;
    },
    getSource: async (id) => {
      record("getSource", id);
      return {
        source: {
          id,
          workspaceId: "space_a",
          name: "repo",
          url: "https://example.test/r.git",
          defaultRef: "main",
          defaultPath: ".",
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      };
    },
    patchSource: async (id, patch) => {
      record("patchSource", id, patch);
      return {
        source: {
          id,
          workspaceId: "space_a",
          name: patch.name ?? "repo",
          url: "https://example.test/r.git",
          defaultRef: patch.defaultRef ?? "main",
          defaultPath: patch.defaultPath ?? ".",
          ...(patch.authConnectionId === undefined
            ? {}
            : patch.authConnectionId === null
              ? {}
              : { authConnectionId: patch.authConnectionId }),
          status: patch.status ?? "active",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
      };
    },
    listSources: async (workspaceId) => {
      record("listSources", workspaceId);
      return { sources: [] } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["listSources"]>
      >;
    },
    createSourceSync: async (sourceId, options) => {
      record("createSourceSync", sourceId, options);
      return { run: { id: "ssr_1" } };
    },
    listSourceSnapshots: async (sourceId) => {
      record("listSourceSnapshots", sourceId);
      return {
        snapshots: [
          {
            id: "snap_1",
            origin: "git",
            workspaceId: "space_a",
            sourceId,
            url: "https://example.test/r.git",
            ref: "main",
            resolvedCommit: "a".repeat(40),
            path: ".",
            archiveObjectKey:
              "spaces/space_a/sources/src_x/snapshots/snap_1/source.tar.zst",
            archiveDigest: `sha256:${"b".repeat(64)}`,
            archiveSizeBytes: 123,
            fetchedByRunId: "ssr_1",
            fetchedAt: "2026-01-01T00:00:00Z",
          },
        ],
      };
    },
    createSourceCompatibilityCheck: async (sourceId, request) => {
      record("createSourceCompatibilityCheck", sourceId, request);
      return {
        report: {
          id: "caprep_1",
          sourceId,
          sourceSnapshotId: request?.sourceSnapshotId ?? "snap_1",
          level: "ready",
          findings: [],
          providers: [],
          resources: [],
          dataSources: [],
          provisioners: [],
          createdAt: "2026-01-01T00:00:00Z",
        },
      };
    },
    getCompatibilityReport: async (reportId) => {
      record("getCompatibilityReport", reportId);
      return {
        report: {
          id: reportId,
          sourceId: "src_x",
          sourceSnapshotId: "snap_1",
          level: "ready",
          findings: [],
          providers: [],
          resources: [],
          dataSources: [],
          provisioners: [],
          createdAt: "2026-01-01T00:00:00Z",
        },
      };
    },
    listProviderCatalogEntries: async () => {
      record("listProviderCatalogEntries");
      return {
        providers: [
          {
            id: "cloudflare",
            providerSource: "registry.opentofu.org/cloudflare/cloudflare",
            displayName: "Cloudflare",
            recommendedEnvNames: ["CLOUDFLARE_API_TOKEN"],
            helpers: ["cloudflare_api_token", "cloudflare_oauth"],
            ownershipOptions: ["env"],
            allowedResources: ["cloudflare_workers_script"],
            allowedDataSources: [],
            policyPackId: "policy_cloudflare",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      };
    },
    listRunnerProfiles: async () => {
      record("listRunnerProfiles");
      return { runnerProfiles: [] };
    },
  };
  return Object.assign({ calls }, base, overrides, {
    spaces: { ...base.spaces, ...overrides.spaces },
  }) as ControlPlaneOperations & {
    calls: Record<string, unknown[]>;
  };
}

function request(
  method: string,
  path: string,
  init: { authToken?: string; cookie?: string; body?: unknown } = {},
): { request: Request; url: URL } {
  const url = new URL(`${ORIGIN}${path}`);
  const headers: Record<string, string> = {};
  if (init.authToken) headers.authorization = `Bearer ${init.authToken}`;
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return {
    request: new Request(url, {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    url,
  };
}

// --- /api/v1 edge surface ownership + session dispatcher -------------------

test("isControlRoutePath owns /api/v1 and its subtree only", () => {
  expect(isControlRoutePath("/api/v1")).toEqual(true);
  expect(isControlRoutePath("/api/v1/spaces")).toEqual(true);
  expect(isControlRoutePath("/api/v1/runs/plan_1/logs")).toEqual(true);
  expect(isControlRoutePath("/api/v1x")).toEqual(false);
  expect(isControlRoutePath("/v1/installation-projections")).toEqual(false);
  expect(isControlRoutePath("/v1/account/session/me")).toEqual(false);
});

test("GET /api/v1/spaces serves the session control surface", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/api/v1/spaces", { cookie });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { spaces: unknown[] };
  expect(body.spaces.length).toEqual(1);
  // The session list scopes the read to the caller's own spaces; it must NOT
  // load every tenant's Workspace via the all-spaces `listWorkspaces` path.
  expect(operations.calls.listWorkspacesByOwner).toBeDefined();
  expect(operations.calls.listWorkspaces).toBeUndefined();
  // GET /spaces also synchronously ensures the first-login personal Workspace so
  // an OAuth redirect cannot land the dashboard in an empty Workspace race.
  const createCall = operations.calls.createWorkspace?.[0] as
    { ownerUserId?: string; type?: string } | undefined;
  expect(createCall?.ownerUserId).toEqual("tsub_ctrl");
  expect(createCall?.type).toEqual("personal");
});

test("GET /api/v1/spaces accepts a personal access token bearer", async () => {
  const store = new InMemoryAccountsStore();
  const token = "takpat_control_read";
  seedPersonalAccessToken(store, { token, scopes: ["read"] });
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/api/v1/spaces", {
    authToken: token,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { spaces: unknown[] };
  expect(body.spaces.length).toEqual(1);
  expect(operations.calls.listWorkspacesByOwner).toEqual(["tsub_ctrl"]);
  // PAT callers are automation clients; they should not trigger the
  // session-cookie first-login personal Workspace hook.
  expect(operations.calls.createWorkspace).toBeUndefined();
  expect(typeof store.findPersonalAccessToken(token)?.lastUsedAt).toEqual(
    "number",
  );
});

test("mutation routes reject read-only personal access tokens", async () => {
  const store = new InMemoryAccountsStore();
  const token = "takpat_control_read_only";
  seedPersonalAccessToken(store, { token, scopes: ["read"] });
  const operations = fakeOperations();
  const { request: req, url } = request("POST", "/api/v1/spaces", {
    authToken: token,
    body: { handle: "blocked", displayName: "Blocked", type: "personal" },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  const body = (await response!.json()) as { error: { code: string } };
  expect(body.error.code).toEqual("insufficient_scope");
  expect(operations.calls.createWorkspace).toBeUndefined();
});

test("GET /api/v1/workspaces aliases the final Workspace route", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/api/v1/workspaces", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { spaces: unknown[] };
  expect(body.spaces.length).toEqual(1);
  expect(operations.calls.listWorkspacesByOwner).toBeDefined();
});

test("GET /api/v1/workspaces hides archived Workspaces unless requested", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const active = {
    id: "space_active",
    handle: "active",
    displayName: "Active",
    type: "personal" as const,
    ownerUserId: "tsub_ctrl",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const archived = {
    ...active,
    id: "space_e2e",
    handle: "browser-e2e-production",
    displayName: "Takosumi production browser E2E",
    archivedAt: "2026-01-02T00:00:00Z",
  };
  const operations = fakeOperations({
    spaces: {
      listWorkspacesByOwner: async () => [active, archived],
    },
  });

  const hidden = request("GET", "/api/v1/workspaces", { cookie });
  const hiddenResp = await handleControlRoute({
    request: hidden.request,
    url: hidden.url,
    store,
    operations,
  });
  expect(hiddenResp?.status).toEqual(200);
  const hiddenBody = (await hiddenResp!.json()) as {
    spaces: Array<{ id: string }>;
  };
  expect(hiddenBody.spaces.map((space) => space.id)).toEqual(["space_active"]);

  const included = request("GET", "/api/v1/workspaces?includeArchived=true", {
    cookie,
  });
  const includedResp = await handleControlRoute({
    request: included.request,
    url: included.url,
    store,
    operations,
  });
  expect(includedResp?.status).toEqual(200);
  const includedBody = (await includedResp!.json()) as {
    spaces: Array<{ id: string }>;
  };
  expect(includedBody.spaces.map((space) => space.id)).toEqual([
    "space_active",
    "space_e2e",
  ]);
});

test("PATCH /api/v1/workspaces/:id archives a non-last Workspace", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const active = {
    id: "space_active",
    handle: "active",
    displayName: "Active",
    type: "personal" as const,
    ownerUserId: "tsub_ctrl",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const target = {
    ...active,
    id: "space_target",
    handle: "browser-e2e-production",
  };
  const operations = fakeOperations({
    spaces: {
      listWorkspacesByOwner: async () => [active, target],
      getWorkspace: async (id) => (id === "space_target" ? target : active),
    },
  });
  const { request: req, url } = request(
    "PATCH",
    "/api/v1/workspaces/space_target",
    { cookie, body: { archived: true } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    space: { id: string; archivedAt?: string };
  };
  expect(body.space.id).toEqual("space_target");
  expect(body.space.archivedAt).toEqual("2026-01-02T00:00:00Z");
  expect(operations.calls.updateWorkspace?.[1]).toEqual({ archived: true });
});

test("PATCH /api/v1/workspaces/:id rejects archiving the last active Workspace", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("PATCH", "/api/v1/workspaces/space_a", {
    cookie,
    body: { archived: true },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(409);
  expect(operations.calls.updateWorkspace).toBeUndefined();
});

test("GET /api/v1/workspaces/:id/capsules aliases the final Capsule list route", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/workspaces/space_a/capsules",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { installations: unknown[] };
  expect(body.installations.length).toEqual(1);
  expect(operations.calls.listCapsulesPage?.[0]).toEqual("space_a");
});

test("GET /api/v1/workspaces/:id/runs lists the Workspace Run ledger", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/workspaces/space_a/runs?limit=2",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    runs: readonly { id: string; providerResolutions?: unknown[] }[];
  };
  expect(body.runs.map((run) => run.id)).toEqual(["apply_1", "plan_1"]);
  expect(body.runs[0]?.providerResolutions).toBeUndefined();
  expect(operations.calls.listRuns).toEqual(["space_a", { limit: 2 }]);
});

test("anonymous /api/v1 requests are 401", async () => {
  const store = new InMemoryAccountsStore();
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/api/v1/spaces");
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(401);
  await response?.body?.cancel();
  expect(operations.calls.listWorkspaces).toBeUndefined();
});

test("GET /api/v1/spaces/:id a session cannot access is 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store, { subject: "tsub_outsider" });
  // The Workspace is owned by a DIFFERENT subject; the outsider session is denied.
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/api/v1/spaces/space_other", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  await response?.body?.cancel();
});

// --- Anonymous = 401 -------------------------------------------------------

test("anonymous control requests are 401 across the family", async () => {
  const store = new InMemoryAccountsStore();
  const operations = fakeOperations();
  const paths: Array<[string, string]> = [
    ["GET", "/api/v1/spaces"],
    ["POST", "/api/v1/spaces"],
    ["POST", "/api/v1/deploy"],
    ["POST", "/api/v1/spaces/space_a/uploads"],
    ["GET", "/api/v1/spaces/space_a/installations"],
    ["GET", "/api/v1/spaces/space_a/graph"],
    ["GET", "/api/v1/spaces/space_a/activity"],
    ["GET", "/api/v1/workspaces/space_a/runs"],
    ["GET", "/api/v1/spaces/space_a/backups"],
    ["POST", "/api/v1/spaces/space_a/backups"],
    ["POST", "/api/v1/spaces/space_a/backups/bkp_1/restores"],
    ["GET", "/api/v1/spaces/space_a/billing"],
    ["GET", "/api/v1/spaces/space_a/usage"],
    ["GET", "/api/v1/spaces/space_a/credit-reservations"],
    ["POST", "/api/v1/spaces/space_a/plan-update"],
    ["POST", "/api/v1/spaces/space_a/drift-check"],
    ["GET", "/api/v1/installations/inst_1"],
    ["PATCH", "/api/v1/installations/inst_1"],
    ["DELETE", "/api/v1/installations/inst_1"],
    ["GET", "/api/v1/installations/inst_1/provider-connections"],
    ["POST", "/api/v1/installations/inst_1/plan"],
    ["POST", "/api/v1/installations/inst_1/drift-check"],
    ["POST", "/api/v1/installations/inst_1/backups"],
    ["GET", "/api/v1/installations/inst_1/dependencies"],
    ["GET", "/api/v1/capsule-configs"],
    ["GET", "/api/v1/capsule-configs/cfg_default"],
    ["GET", "/api/v1/providers"],
    ["GET", "/api/v1/sources/src_x"],
    ["POST", "/api/v1/sources/src_x/compatibility-check"],
    ["GET", "/api/v1/compatibility-reports/caprep_1"],
    ["POST", "/api/v1/runs/plan_1/apply"],
    ["GET", "/api/v1/runs/plan_1"],
    ["GET", "/api/v1/runs/plan_1/events"],
    ["POST", "/api/v1/runs/plan_1/cancel"],
    ["GET", "/api/v1/runs/plan_1/cost"],
    ["GET", "/api/v1/run-groups/rg_1"],
    ["GET", "/api/v1/connections?workspaceId=space_a"],
    ["POST", "/api/v1/connections/conn_1/test"],
    ["POST", "/api/v1/connections/conn_1/revoke"],
    ["GET", "/api/v1/provider-connections"],
  ];
  for (const [method, path] of paths) {
    const { request: req, url } = request(method, path);
    const response = await handleControlRoute({
      request: req,
      url,
      store,
      operations,
    });
    expect(response?.status, `${method} ${path}`).toEqual(401);
    await response?.body?.cancel();
  }
  // No facade method should have been reached behind the auth gate.
  expect(Object.keys(operations.calls).length).toEqual(0);
});

// --- 503 when the facade is absent (after the session gate) -----------------

test("control routes 503 when no operations facade is wired", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const { request: req, url } = request("GET", "/api/v1/spaces", {
    cookie,
  });
  const response = await handleControlRoute({ request: req, url, store });
  expect(response?.status).toEqual(503);
});

// --- Session happy paths ---------------------------------------------------

test("GET /api/v1/spaces returns spaces for a session", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/api/v1/spaces", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { spaces: unknown[] };
  expect(body.spaces.length).toEqual(1);
  expect(operations.calls.listWorkspacesByOwner).toBeDefined();
  expect(operations.calls.listWorkspaces).toBeUndefined();
});

test("POST /api/v1/spaces/:id/uploads records an upload snapshot for an owned Workspace", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const url = new URL(`${ORIGIN}/api/v1/spaces/space_a/uploads?path=deploy`);
  const req = new Request(url, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/zstd",
    },
    body: new Uint8Array([1, 2, 3]),
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as { snapshot: { id: string } };
  expect(body.snapshot.id).toEqual("snap_upload");
  expect(operations.calls.recordUploadArchive).toEqual([
    { workspaceId: "space_a", bytes: [1, 2, 3], path: "deploy" },
  ]);
});

test("POST /api/v1/spaces/:id/artifact-snapshots records a prepared artifact snapshot", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/artifact-snapshots",
    {
      cookie,
      body: {
        url: "https://artifacts.example.com/app/source.tar.zst",
        digest:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        path: "infra",
      },
    },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as {
    snapshot: { id: string; origin: string };
  };
  expect(body.snapshot).toMatchObject({
    id: "snap_artifact",
    origin: "artifact",
  });
  expect(operations.calls.recordArtifactSnapshot).toEqual([
    {
      workspaceId: "space_a",
      url: "https://artifacts.example.com/app/source.tar.zst",
      digest:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      path: "infra",
    },
  ]);
});

test("POST /api/v1/deploy deploys an uploaded snapshot through the public facade", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    connections: {
      listProviderConnections: async () => [
        {
          id: "conn_cf",
          workspaceId: "space_a",
          provider: "cloudflare",
          providerSource: "registry.opentofu.org/cloudflare/cloudflare",
          kind: "cloudflare_api_token",
          scope: "space",
          displayName: "Cloudflare",
          materialization: "secret",
          status: "verified",
          envNames: ["CLOUDFLARE_API_TOKEN"],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    },
  });
  const { request: req, url } = request("POST", "/api/v1/deploy", {
    cookie,
    body: {
      workspaceId: "space_a",
      name: "hello",
      environment: "preview",
      snapshotId: "snap_upload",
      modulePath: "takos/deploy/opentofu",
      vars: { greeting: "hi" },
      outputAllowlist: {
        url: { from: "url", type: "url", required: true },
        worker_name: { from: "worker_name", type: "string" },
      },
      providerConnections: [
        {
          provider: "cloudflare",
          alias: "main",
          connectionId: "conn_cf",
        },
      ],
      autoApprove: true,
    },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { installation: { id: string } };
  expect(body.installation.id).toEqual("inst_upload");
  expect(operations.calls.deployUpload).toEqual([
    {
      workspaceId: "space_a",
      spaceId: "space_a",
      name: "hello",
      environment: "preview",
      snapshotId: "snap_upload",
      modulePath: "takos/deploy/opentofu",
      vars: { greeting: "hi" },
      outputAllowlist: {
        url: { from: "url", type: "url", required: true },
        worker_name: { from: "worker_name", type: "string" },
      },
      providerEnvBindings: [
        {
          provider: "cloudflare",
          alias: "main",
          connectionId: "conn_cf",
        },
      ],
      autoApprove: true,
    },
  ]);
  const projection = await store.findAppCapsule("inst_upload");
  expect(projection?.status).toEqual("installing");
  expect(projection?.workspaceId).toEqual("space_a");
  expect(projection?.createdBySubject).toEqual("tsub_ctrl");
  expect(projection?.sourceGitUrl).toEqual("upload://space_a");
  expect(projection?.sourceRef).toEqual("upload");
  expect(projection?.sourceCommit).toEqual(
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  const events = await store.listCapsuleEvents("inst_upload");
  expect(events.map((event) => event.eventType)).toEqual([
    "installation.created",
  ]);
});

test("POST /api/v1/deploy can create a shared-cell projection with a RuntimeBinding", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("POST", "/api/v1/deploy", {
    cookie,
    body: {
      workspaceId: "space_a",
      name: "hello",
      snapshotId: "snap_upload",
      projectionMode: "shared-cell",
    },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
    sharedCellRuntime: async ({ capsuleId, now }) => ({
      runtimeBindingId: `rtb_${capsuleId}_shared_cell`,
      capsuleId,
      mode: "shared-cell",
      targetType: "shared-cell",
      targetId: `shared-cell://tokyo-cell-01/namespaces/${capsuleId}`,
      createdAt: now,
      updatedAt: now,
    }),
  });

  expect(response?.status).toEqual(200);
  expect(operations.calls.deployUpload).toEqual([
    {
      workspaceId: "space_a",
      spaceId: "space_a",
      name: "hello",
      snapshotId: "snap_upload",
    },
  ]);
  const projection = await store.findAppCapsule("inst_upload");
  expect(projection?.mode).toEqual("shared-cell");
  expect(projection?.runtimeBindingId).toEqual("rtb_inst_upload_shared_cell");
  const runtimeBinding = projection?.runtimeBindingId
    ? await store.findRuntimeBinding(projection.runtimeBindingId)
    : undefined;
  expect(runtimeBinding?.targetId).toEqual(
    "shared-cell://tokyo-cell-01/namespaces/inst_upload",
  );
});

test("GET /api/v1/runs/:id syncs a succeeded apply into an export-ready projection", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    getRun: async (id) =>
      ({
        id,
        workspaceId: "space_a",
        capsuleId: "inst_upload",
        type: "apply",
        status: "succeeded",
        planDigest: `sha256:${"d".repeat(64)}`,
        createdBy: "test",
        createdAt: "2026-01-01T00:00:00Z",
      }) as unknown as Awaited<ReturnType<ControlPlaneOperations["getRun"]>>,
  });
  const deploy = request("POST", "/api/v1/deploy", {
    cookie,
    body: {
      workspaceId: "space_a",
      name: "hello",
      snapshotId: "snap_upload",
    },
  });
  const deployResponse = await handleControlRoute({
    request: deploy.request,
    url: deploy.url,
    store,
    operations,
  });
  expect(deployResponse?.status).toEqual(200);
  expect((await store.findAppCapsule("inst_upload"))?.status).toEqual(
    "installing",
  );

  const poll = request("GET", "/api/v1/runs/apply_upload", { cookie });
  const pollResponse = await handleControlRoute({
    request: poll.request,
    url: poll.url,
    store,
    operations,
  });
  expect(pollResponse?.status).toEqual(200);
  const projection = await store.findAppCapsule("inst_upload");
  expect(projection?.status).toEqual("ready");
  const events = await store.listCapsuleEvents("inst_upload");
  expect(events.map((event) => event.eventType)).toEqual([
    "installation.created",
    "installation.status_changed",
  ]);
});

test("POST /api/v1/deploy rejects internal resolver bindings", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("POST", "/api/v1/deploy", {
    cookie,
    body: {
      workspaceId: "space_a",
      name: "hello",
      snapshotId: "snap_upload",
      providerEnvBindings: [
        {
          provider: "cloudflare",
          alias: "main",
          envId: "penv_cf",
        },
      ],
    },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(400);
  const raw = await response!.text();
  expect(raw).toContain("providerConnections");
  expect(operations.calls.deployUpload).toBeUndefined();
});

test("GET /api/v1/spaces unions directly-owned + legal-owner spaces, excludes foreign", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie, subject } = seedSession(store);
  // (B) An org Workspace whose deploy-control owner is someone else, but whose
  // accounts ledger account is LEGALLY OWNED by the session subject -> visible.
  seedLedgerWorkspace(store, {
    subject,
    accountId: "acct_org",
    workspaceId: "space_org",
  });
  // A foreign Workspace: different ledger account, legally owned by another subject
  // -> must be absent. (Also never directly owned by the session subject.)
  seedLedgerWorkspace(store, {
    subject: "tsub_foreign",
    accountId: "acct_foreign",
    workspaceId: "space_foreign",
  });

  const spaceRecord = (id: string, ownerUserId: string) => ({
    id,
    handle: id,
    displayName: id,
    type: "organization" as const,
    ownerUserId,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  let listWorkspacesByOwnerCalled = false;
  const operations = fakeOperations({
    spaces: {
      // (A) Direct owner: only the personal Workspace the subject owns directly.
      listWorkspacesByOwner: async () => {
        listWorkspacesByOwnerCalled = true;
        return [spaceRecord("space_a", subject)];
      },
      // Per-id fetch is bounded to the subject's own ledger spaces; the org
      // Workspace is owned (deploy-control) by another subject but is reachable via
      // the legal-owner branch. A foreign-space fetch would still be excluded
      // because the route only fetches ledger spaces owned by the subject.
      getWorkspace: async (id) => {
        if (id === "space_org") return spaceRecord("space_org", "tsub_other");
        if (id === "space_foreign") {
          return spaceRecord("space_foreign", "tsub_foreign");
        }
        return spaceRecord(id, subject);
      },
    },
  });

  const { request: req, url } = request("GET", "/api/v1/spaces", { cookie });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { spaces: { id: string }[] };
  const ids = body.spaces.map((s) => s.id).sort();
  expect(ids).toEqual(["space_a", "space_org"]);
  expect(ids).not.toContain("space_foreign");
  // The all-tenants load-all path must never run for a session list.
  expect(operations.calls.listWorkspaces).toBeUndefined();
  expect(listWorkspacesByOwnerCalled).toEqual(true);
});

test("GET /api/v1/spaces/:id/billing returns billing settings and balance", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/billing",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    billing: {
      settings: { mode: string };
      balance: { availableCredits: number; reservedCredits: number };
    };
  };
  expect(body.billing.settings.mode).toEqual("showback");
  expect(body.billing.balance.availableCredits).toEqual(120);
  expect(body.billing.balance.reservedCredits).toEqual(8);
  expect(operations.calls.getWorkspaceBilling).toEqual(["space_a"]);
});

test("GET /api/v1/billing/plans returns public plan projections", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/api/v1/billing/plans", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
    publicBillingPlans: [
      {
        id: "starter",
        kind: "subscription",
        stripePriceId: "price_test_hidden",
        estimatedNetRevenueUsdMicros: 4000000,
        usdMicros: 3000000,
        name: { en: "Starter", ja: "Starter" },
        priceDisplay: { en: "$3 balance", ja: "$3 残高" },
      },
    ],
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    plans: readonly Record<string, unknown>[];
  };
  expect(body.plans.map((plan) => plan.id)).toEqual(["starter"]);
  expect(body.plans[0]).not.toHaveProperty("stripePriceId");
  expect(body.plans[0]).not.toHaveProperty("estimatedNetRevenueUsdMicros");
  expect(body.plans[0]?.priceDisplay).toEqual({
    en: "$3 balance",
    ja: "$3 残高",
  });
});

test("GET /api/v1/spaces/:id/usage returns usage events", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/api/v1/spaces/space_a/usage", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { usageEvents: unknown[] };
  expect(body.usageEvents.length).toEqual(1);
  expect(operations.calls.listWorkspaceUsage).toEqual(["space_a"]);
});

test("GET /api/v1/spaces/:id/credit-reservations returns reservation history", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/credit-reservations",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { creditReservations: unknown[] };
  expect(body.creditReservations.length).toEqual(1);
  expect(operations.calls.listWorkspaceCreditReservations).toEqual(["space_a"]);
});

test("GET /api/v1/spaces/:id/backups lists Workspace backups", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/backups",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { backups: unknown[] };
  expect(body.backups.length).toEqual(1);
  expect(operations.calls.listBackups).toEqual(["space_a"]);
});

test("POST /api/v1/spaces/:id/backups creates a Workspace backup", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/backups",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as { backup: { workspaceId: string } };
  expect(body.backup.workspaceId).toEqual("space_a");
  expect(operations.calls.createBackup).toEqual([{ workspaceId: "space_a" }]);
});

test("POST /api/v1/spaces/:id/backups/:backupId/restores creates a restore Run", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie, subject } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/backups/bkp_1/restores",
    {
      cookie,
      body: {
        capsuleId: "inst_1",
        environment: "prod",
        stateGeneration: 0,
        expectedBackupDigest: `sha256:${"a".repeat(64)}`,
      },
    },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  expect(operations.calls.createRestoreRun).toEqual([
    "space_a",
    "bkp_1",
    {
      capsuleId: "inst_1",
      environment: "prod",
      stateGeneration: 0,
      expectedBackupDigest: `sha256:${"a".repeat(64)}`,
    },
    { actor: subject },
  ]);
});

test("session surface refuses billing mutations (operator-only, spec §32)", async () => {
  // Billing mode is operator-selected and credits enter through paid checkout;
  // the operator mutations live on the bearer-gated /internal/v1 surface. A
  // session caller must not be able to top-up credits or flip the billing
  // mode — both former routes now fall through to the spaces-family 404.
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  for (const [path, body] of [
    ["/api/v1/spaces/space_a/credits/top-up", { credits: 50 }],
    [
      "/api/v1/spaces/space_a/subscription/change",
      { billingSettings: { mode: "disabled" } },
    ],
  ] as const) {
    const { request: req, url } = request("POST", path, { cookie, body });
    const response = await handleControlRoute({
      request: req,
      url,
      store,
      operations,
    });
    expect(response?.status, path).toEqual(404);
    await response?.body?.cancel();
  }
  expect(operations.calls.topUpWorkspaceCredits).toBeUndefined();
  expect(operations.calls.changeWorkspaceSubscription).toBeUndefined();
});

test("GET /api/v1/spaces filters out spaces the session cannot access", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const visible = {
    id: "space_a",
    handle: "mine",
    displayName: "Mine",
    type: "personal" as const,
    ownerUserId: "tsub_ctrl",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const hidden = {
    ...visible,
    id: "space_b",
    handle: "other",
    displayName: "Other",
    ownerUserId: "tsub_other",
  };
  const operations = fakeOperations({
    spaces: {
      listWorkspaces: async () => [visible, hidden],
      getWorkspace: async (id) => (id === "space_b" ? hidden : visible),
      createWorkspace: async (req) => ({
        ...visible,
        id: "space_new",
        handle: req.handle,
        displayName: req.displayName,
        type: req.type,
        ownerUserId: req.ownerUserId,
      }),
    },
  });
  const { request: req, url } = request("GET", "/api/v1/spaces", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { spaces: Array<{ id: string }> };
  expect(body.spaces.map((space) => space.id)).toEqual(["space_a"]);
});

test("PATCH /api/v1/spaces/:id updates display name and policy after Workspace access", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const policy = {
    allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    quota: { "resources.total": 10 },
  };
  const { request: req, url } = request("PATCH", "/api/v1/spaces/space_a", {
    cookie,
    body: {
      displayName: "Shota Lab",
      policy,
    },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { space: { displayName: string } };
  expect(body.space.displayName).toEqual("Shota Lab");
  expect(operations.calls.updateWorkspace).toEqual([
    "space_a",
    {
      displayName: "Shota Lab",
      policy,
    },
  ]);
  expect(operations.calls.activityRecord?.[0]).toEqual({
    workspaceId: "space_a",
    spaceId: "space_a",
    actorId: "tsub_ctrl",
    action: "space.updated",
    targetType: "space",
    targetId: "space_a",
    metadata: {
      fields: ["displayName", "policy"],
      policyDigest: await stableJsonDigest(policy),
    },
  });
});

test("PATCH /api/v1/spaces/:id rejects policy that is not a JSON object", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("PATCH", "/api/v1/spaces/space_a", {
    cookie,
    body: { policy: [] },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(400);
  expect(operations.calls.updateWorkspace).toBeUndefined();
});

test("space-scoped control route rejects a non-member session before dispatch", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listWorkspaces: async () => [],
      getWorkspace: async (id) => ({
        id,
        handle: "other",
        displayName: "Other",
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createWorkspace: async (req) => ({
        id: "space_new",
        handle: req.handle,
        displayName: req.displayName,
        type: req.type,
        ownerUserId: req.ownerUserId,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
  });
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_b/installations",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.listCapsules).toBeUndefined();
  expect(operations.calls.listCapsulesPage).toBeUndefined();
});

test("PATCH /api/v1/spaces/:id rejects a non-member session before dispatch", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      getWorkspace: async (id) => ({
        id,
        handle: "other",
        displayName: "Other",
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
  });
  const { request: req, url } = request("PATCH", "/api/v1/spaces/space_b", {
    cookie,
    body: { displayName: "Nope" },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.updateWorkspace).toBeUndefined();
});

test("installation-scoped control route rejects when its Workspace is inaccessible", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listWorkspaces: async () => [],
      getWorkspace: async (id) => ({
        id,
        handle: "other",
        displayName: "Other",
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createWorkspace: async (req) => ({
        id: "space_new",
        handle: req.handle,
        displayName: req.displayName,
        type: req.type,
        ownerUserId: req.ownerUserId,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
    installations: {
      getCapsule: async (id) => ({
        id,
        workspaceId: "space_b",
        name: "app",
        slug: "app",
        sourceId: "src_x",
        installType: "opentofu_module" as const,
        installConfigId: "cfg_x",
        environment: "prod",
        currentStateGeneration: 0,
        status: "ready" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      listCapsules: async () => [],
      listCapsulesPage: async () => ({ items: [] }),
      createCapsule: async () => {
        throw new Error("unexpected");
      },
      listInstallConfigs: async () => [],
      putCapsuleProviderEnvBindingSet: async (profile) => profile,
      getCapsuleProviderEnvBindingSetByCapsule: async () => undefined,
    },
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/installations/inst_other/plan",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.createCapsulePlan).toBeUndefined();
});

test("POST /api/v1/spaces/:id/installations rejects a Source from another inaccessible Workspace", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listWorkspaces: async () => [],
      getWorkspace: async (id) => ({
        id,
        handle: id === "space_a" ? "mine" : "other",
        displayName: id === "space_a" ? "Mine" : "Other",
        type: "personal" as const,
        ownerUserId: id === "space_a" ? "tsub_ctrl" : "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createWorkspace: async (req) => ({
        id: "space_new",
        handle: req.handle,
        displayName: req.displayName,
        type: req.type,
        ownerUserId: req.ownerUserId,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
    getSource: async (id) => ({
      source: {
        id,
        workspaceId: "space_b",
        name: "foreign",
        url: "https://example.test/foreign.git",
        defaultRef: "main",
        defaultPath: ".",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    }),
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/installations",
    {
      cookie,
      body: {
        name: "app",
        environment: "prod",
        sourceId: "src_foreign",
        installConfigId: "cfg_x",
      },
    },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.createCapsule).toBeUndefined();
});

test("POST /api/v1/sources rejects an authConnectionId from another inaccessible Workspace", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listWorkspaces: async () => [],
      getWorkspace: async (id) => ({
        id,
        handle: id === "space_a" ? "mine" : "other",
        displayName: id === "space_a" ? "Mine" : "Other",
        type: "personal" as const,
        ownerUserId: id === "space_a" ? "tsub_ctrl" : "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createWorkspace: async (req) => ({
        id: "space_new",
        handle: req.handle,
        displayName: req.displayName,
        type: req.type,
        ownerUserId: req.ownerUserId,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
    getConnection: async (connectionId) => ({
      id: connectionId,
      workspaceId: "space_b",
      provider: "git",
      kind: "source_git_https_token",
      authMethod: "static_secret",
      scope: "space",
      status: "active",
      envNames: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }),
  });
  const { request: req, url } = request("POST", "/api/v1/sources", {
    cookie,
    body: {
      workspaceId: "space_a",
      name: "repo",
      url: "https://example.test/repo.git",
      authConnectionId: "conn_foreign",
    },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.createSource).toBeUndefined();
});

test("POST /api/v1/output-shares rejects a producer from another inaccessible Workspace", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listWorkspaces: async () => [],
      getWorkspace: async (id) => ({
        id,
        handle: id === "space_a" ? "mine" : "other",
        displayName: id === "space_a" ? "Mine" : "Other",
        type: "personal" as const,
        ownerUserId: id === "space_a" ? "tsub_ctrl" : "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createWorkspace: async (req) => ({
        id: "space_new",
        handle: req.handle,
        displayName: req.displayName,
        type: req.type,
        ownerUserId: req.ownerUserId,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
    installations: {
      getCapsule: async (id) => ({
        id,
        workspaceId: "space_b",
        name: "foreign",
        slug: "foreign",
        sourceId: "src_foreign",
        installType: "opentofu_module" as const,
        installConfigId: "cfg_foreign",
        environment: "prod",
        currentStateGeneration: 0,
        status: "ready" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      listCapsules: async () => [],
      listCapsulesPage: async () => ({ items: [] }),
      createCapsule: async () => {
        throw new Error("unexpected");
      },
      listInstallConfigs: async () => [],
      putCapsuleProviderEnvBindingSet: async (profile) => profile,
      getCapsuleProviderEnvBindingSetByCapsule: async () => undefined,
    },
  });
  const { request: req, url } = request("POST", "/api/v1/output-shares", {
    cookie,
    body: {
      fromWorkspaceId: "space_a",
      toWorkspaceId: "space_b",
      producerCapsuleId: "inst_foreign",
      outputs: [{ name: "domain" }],
    },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.createOutputShare).toBeUndefined();
});

test("GET /api/v1/provider-connections rejects an inaccessible Workspace before dispatch", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listWorkspaces: async () => [],
      getWorkspace: async (id) => ({
        id,
        handle: "other",
        displayName: "Other",
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createWorkspace: async (req) => ({
        id: "space_new",
        handle: req.handle,
        displayName: req.displayName,
        type: req.type,
        ownerUserId: req.ownerUserId,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
  });
  const { request: req, url } = request(
    "GET",
    "/api/v1/provider-connections?workspaceId=space_b",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.listProviderConnections).toBeUndefined();
});

test("GET /api/v1/provider-connections returns the Workspace's provider connections and never echoes secrets", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // After the credential-model collapse a Provider Connection IS the unified
  // credential record; the session surface lists the Workspace-scoped rows directly
  // (raw connection ids, no `pcn_` hashing) and never the sealed secret material
  // nor operator-scoped credentials.
  const operations = fakeOperations({
    connections: {
      listProviderConnections: async () => [
        {
          // Operator-scoped credential (no workspaceId): must stay internal and is
          // filtered out of the Workspace listing.
          id: "conn_operator_secret",
          provider: "cloudflare",
          providerSource: "registry.opentofu.org/cloudflare/cloudflare",
          kind: "cloudflare_api_token",
          scope: "operator",
          displayName: "Operator credential that must stay internal",
          materialization: "secret",
          status: "verified",
          envNames: ["CLOUDFLARE_API_TOKEN"],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
        {
          id: "conn_space_secret",
          workspaceId: "space_a",
          provider: "cloudflare",
          providerSource: "registry.opentofu.org/cloudflare/cloudflare",
          kind: "cloudflare_api_token",
          scope: "space",
          displayName: "Workspace secret",
          materialization: "secret",
          status: "verified",
          envNames: ["CLOUDFLARE_API_TOKEN"],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
        {
          id: "conn_space_secret_2",
          workspaceId: "space_a",
          provider: "cloudflare",
          providerSource: "registry.opentofu.org/cloudflare/cloudflare",
          kind: "cloudflare_api_token",
          scope: "space",
          displayName: "Second space secret",
          materialization: "secret",
          status: "verified",
          envNames: ["CLOUDFLARE_API_TOKEN"],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
      ],
    },
  });
  const { request: req, url } = request(
    "GET",
    "/api/v1/provider-connections?workspaceId=space_a",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const raw = await response!.text();
  // Operator-scoped credentials never leak into the Workspace listing.
  expect(raw.includes("conn_operator_secret")).toEqual(false);
  // No sealed secret material is ever projected onto the public record.
  expect(raw.includes("secretRef")).toEqual(false);
  expect(raw.includes("secretValue")).toEqual(false);
  expect(raw.includes("gatewayProfileId")).toEqual(false);
  const body = JSON.parse(raw) as {
    providerConnections: readonly Record<string, unknown>[];
  };
  expect(body.providerConnections.length).toEqual(2);
  expect(Object.keys(body.providerConnections[0]!).sort()).toEqual([
    "createdAt",
    "displayName",
    "envNames",
    "id",
    "kind",
    "materialization",
    "provider",
    "providerSource",
    "scope",
    "status",
    "updatedAt",
    "workspaceId",
  ]);
  // The ready state is the ConnectionStatus "verified" (NOT a "ready" alias).
  expect(body.providerConnections.map((item) => item.status)).toEqual([
    "verified",
    "verified",
  ]);
  // Public ids are the raw connection ids (the `pcn_` hashing is removed).
  expect(String(body.providerConnections[0]?.id)).toEqual("conn_space_secret");
});

test("GET /api/v1/spaces/:id/gateway-coverages is not an OSS public route", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/gateway-coverages",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(404);
  expect(operations.calls.getGatewayCoverageStatus).toBeUndefined();
});

test("accounts-ledger Workspace owner can access a Workspace even when ownerUserId is not the session subject", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie, subject } = seedSession(store);
  seedLedgerWorkspace(store, {
    subject,
    accountId: "acct_ctrl",
    workspaceId: "space_ledger",
  });
  const operations = fakeOperations({
    spaces: {
      listWorkspaces: async () => [],
      getWorkspace: async (id) => ({
        id,
        handle: "ledger",
        displayName: "Ledger",
        type: "personal" as const,
        ownerUserId: "tsub_imported_owner",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createWorkspace: async (req) => ({
        id: "space_new",
        handle: req.handle,
        displayName: req.displayName,
        type: req.type,
        ownerUserId: req.ownerUserId,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
  });
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_ledger/installations",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  expect(operations.calls.listCapsulesPage?.[0]).toEqual("space_ledger");
});

test("POST /api/v1/spaces uses the session subject as ownerUserId", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie, subject } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("POST", "/api/v1/spaces", {
    cookie,
    body: { handle: "myspace", displayName: "My Workspace", type: "personal" },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const createCall = operations.calls.createWorkspace?.[0] as {
    ownerUserId: string;
    handle: string;
  };
  expect(createCall.ownerUserId).toEqual(subject);
  expect(createCall.handle).toEqual("myspace");
});

test("GET /api/v1/spaces/:id/installations lists installations", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/installations",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { installations: unknown[] };
  expect(body.installations.length).toEqual(1);
  const installation = body.installations[0] as {
    installType?: string;
    currentOutputId?: string;
  };
  expect(installation.installType).toBeUndefined();
  expect(installation.currentOutputId).toBeUndefined();
  expect(operations.calls.listCapsulesPage?.[0]).toEqual("space_a");
});

test("POST /api/v1/spaces/:id/installations creates an installation", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/installations",
    {
      cookie,
      body: {
        name: "app",
        environment: "prod",
        sourceId: "src_x",
        installConfigId: "cfg_x",
      },
    },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as {
    installation: { installType?: string; currentOutputId?: string };
  };
  expect(body.installation.installType).toBeUndefined();
  expect(body.installation.currentOutputId).toBeUndefined();
  const createCall = operations.calls.createCapsule?.[0] as {
    workspaceId: string;
  };
  expect(createCall.workspaceId).toEqual("space_a");
});

test("POST /api/v1/spaces/:id/installations stores per-install vars in a scoped InstallConfig", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/installations",
    {
      cookie,
      body: {
        name: "takos",
        environment: "production",
        sourceId: "src_x",
        installConfigId: "cfg_x",
        vars: { project_name: "takos-space-a" },
      },
    },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const config = operations.calls.putInstallConfig?.[0] as {
    id: string;
    workspaceId: string;
    internal?: unknown;
    variableMapping: Record<string, unknown>;
    outputAllowlist: Record<string, unknown>;
  };
  expect(config.id.startsWith("icfg_")).toEqual(true);
  expect(config.workspaceId).toEqual("space_a");
  expect(config.internal).toEqual({ reason: "per_install_overrides" });
  expect(config.variableMapping).toEqual({ project_name: "takos-space-a" });
  expect(config.outputAllowlist).toEqual({
    url: { from: "url", type: "url" },
    worker_name: { from: "worker_name", type: "string" },
  });
  const createCall = operations.calls.createCapsule?.[0] as {
    installConfigId: string;
  };
  expect(createCall.installConfigId).toEqual(config.id);
});

test("POST /api/v1/spaces/:id/installations stores runnerId and outputAllowlist in a scoped InstallConfig", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/installations",
    {
      cookie,
      body: {
        name: "generic",
        environment: "production",
        sourceId: "src_x",
        installConfigId: "cfg_x",
        runnerId: "generic-opentofu-provider",
        outputAllowlist: {
          takos_app: { from: "takos_app", type: "json", required: true },
        },
      },
    },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const config = operations.calls.putInstallConfig?.[0] as {
    id: string;
    workspaceId: string;
    internal?: unknown;
    runnerId?: string;
    variableMapping: Record<string, unknown>;
    outputAllowlist: Record<string, unknown>;
  };
  expect(config.id.startsWith("icfg_")).toEqual(true);
  expect(config.workspaceId).toEqual("space_a");
  expect(config.internal).toEqual({ reason: "per_install_overrides" });
  expect(config.runnerId).toEqual("generic-opentofu-provider");
  expect(config.variableMapping).toEqual({});
  expect(config.outputAllowlist).toEqual({
    takos_app: { from: "takos_app", type: "json", required: true },
  });
  const createCall = operations.calls.createCapsule?.[0] as {
    installConfigId: string;
  };
  expect(createCall.installConfigId).toEqual(config.id);
});

test("POST /api/v1/spaces/:id/installations stores modulePath in a scoped InstallConfig", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/installations",
    {
      cookie,
      body: {
        name: "takos",
        environment: "staging",
        sourceId: "src_x",
        installConfigId: "cfg_x",
        modulePath: "deploy/opentofu",
      },
    },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const config = operations.calls.putInstallConfig?.[0] as {
    id: string;
    internal?: unknown;
    modulePath?: string;
  };
  expect(config.id.startsWith("icfg_")).toEqual(true);
  expect(config.internal).toEqual({ reason: "per_install_overrides" });
  expect(config.modulePath).toEqual("deploy/opentofu");
});

test("POST /api/v1/spaces/:id/installations rejects non-JSON vars", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/installations",
    {
      cookie,
      body: {
        name: "takos",
        environment: "production",
        sourceId: "src_x",
        installConfigId: "cfg_x",
        vars: "project_name=takos",
      },
    },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(400);
  expect(operations.calls.putInstallConfig).toBeUndefined();
  expect(operations.calls.createCapsule).toBeUndefined();
});

test("GET /api/v1/spaces/:id/graph projects nodes + edges", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/api/v1/spaces/space_a/graph", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    nodes: Array<{ capsuleId: string; name: string; status: string }>;
    edges: Array<{
      id: string;
      producerCapsuleId: string;
      outputs: unknown;
    }>;
  };
  expect(body.nodes[0]?.capsuleId).toEqual("inst_1");
  expect(body.nodes[0]?.name).toEqual("app");
  expect(body.edges[0]?.id).toEqual("dep_1");
  expect(body.edges[0]?.producerCapsuleId).toEqual("inst_1");
});

test("GET /api/v1/installations/:id reads one installation", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/api/v1/installations/inst_1", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    installation: { installType?: string; currentOutputId?: string };
  };
  expect(body.installation.installType).toBeUndefined();
  expect(body.installation.currentOutputId).toBeUndefined();
  expect(operations.calls.getCapsule?.[0]).toEqual("inst_1");
});

test("POST /api/v1/installations/:id/backups creates an Capsule-context backup", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/installations/inst_1/backups",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as {
    backup: { workspaceId: string; capsuleId?: string; environment?: string };
  };
  expect(body.backup.workspaceId).toEqual("space_a");
  expect(operations.calls.getCapsule?.[0]).toEqual("inst_1");
  expect(operations.calls.createBackup).toEqual([
    {
      workspaceId: "space_a",
      capsuleId: "inst_1",
      environment: "prod",
    },
  ]);
});

test("GET /api/v1/installations/:id/provider-connections reads provider connection selections", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/installations/inst_1/provider-connections",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    providerConnectionSet: {
      bindings: readonly { connectionId: string }[];
    };
  };
  // The binding-set read projects `bindings` (raw connection ids; the `pcn_`
  // hashing is removed).
  expect(body.providerConnectionSet.bindings[0]?.connectionId).toEqual(
    "conn_cf_gateway",
  );
  expect(operations.calls.getCapsuleProviderEnvBindingSetByCapsule).toEqual([
    "inst_1",
    "prod",
  ]);
});

test("PUT /api/v1/installations/:id/provider-connections saves provider connection selections", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    connections: {
      listProviderConnections: async () => [
        {
          id: "conn_cf",
          workspaceId: "space_a",
          provider: "cloudflare",
          providerSource: "registry.opentofu.org/cloudflare/cloudflare",
          kind: "cloudflare_api_token",
          scope: "space",
          displayName: "Cloudflare",
          materialization: "secret",
          status: "verified",
          envNames: ["CLOUDFLARE_API_TOKEN"],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "conn_aws",
          workspaceId: "space_a",
          provider: "aws",
          providerSource: "registry.opentofu.org/hashicorp/aws",
          kind: "generic_env_provider",
          scope: "space",
          displayName: "AWS",
          materialization: "secret",
          status: "verified",
          envNames: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    },
  });
  const { request: req, url } = request(
    "PUT",
    "/api/v1/installations/inst_1/provider-connections",
    {
      cookie,
      // The PUT request body still uses `connections`.
      body: {
        connections: [
          {
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            alias: "main",
            connectionId: "conn_cf",
          },
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            alias: "archive",
            connectionId: "conn_aws",
          },
        ],
      },
    },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const saved = operations.calls.putCapsuleProviderEnvBindingSet?.[0] as {
    bindings: readonly {
      provider: string;
      alias?: string;
      connectionId: string;
    }[];
  };
  expect(saved.bindings[0]).toEqual({
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    alias: "main",
    connectionId: "conn_cf",
  });
  expect(saved.bindings[1]).toEqual({
    provider: "registry.opentofu.org/hashicorp/aws",
    alias: "archive",
    connectionId: "conn_aws",
  });
});

test("POST /api/v1/installations/:id/plan returns 201", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/installations/inst_1/plan",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as { run: { id: string } };
  expect(body.run.id).toEqual("plan_1");
  expect(operations.calls.createCapsulePlan?.[0]).toEqual({
    capsuleId: "inst_1",
    options: undefined,
  });
  expect(operations.calls.getRun).toContain("plan_1");
  expect(operations.calls.getRunCost).toContain("plan_1");
});

test("POST /api/v1/installations/:id/plan forwards a preflight compatibility report hint", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/installations/inst_1/plan",
    {
      cookie,
      body: { compatibilityReportId: "caprep_ready" },
    },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });

  expect(response?.status).toEqual(201);
  expect(operations.calls.createCapsulePlan?.[0]).toEqual({
    capsuleId: "inst_1",
    options: { compatibilityReportId: "caprep_ready" },
  });
});

test("GET /api/v1/runs/:id projects provider resolutions to provider connections", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    getRun: async (id) =>
      ({
        id,
        workspaceId: "space_a",
        capsuleId: "inst_1",
        type: "plan",
        status: "succeeded",
        createdBy: "test",
        createdAt: "2026-01-01T00:00:00Z",
        providerResolutions: [
          {
            requirement: {
              providerSource: "registry.opentofu.org/cloudflare/cloudflare",
              providerName: "cloudflare",
              alias: "main",
              modulePath: ".",
              discoveredFrom: "required_providers",
              requiredForPhases: ["plan", "apply"],
            },
            status: "resolved_provider_env",
            envId: "penv_cf",
            materialization: "secret",
            evidence: {
              kind: "provider_env",
              provider: "cloudflare",
              envId: "penv_cf",
              materialization: "secret",
              requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
            },
          },
        ],
      }) as Awaited<ReturnType<ControlPlaneOperations["getRun"]>>,
  });
  const { request: req, url } = request("GET", "/api/v1/runs/run_1", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const raw = await response!.text();
  // The public projection drops the internal `materialization` axis and renames
  // the `provider_env` vocabulary to `provider_connection`.
  expect(raw.includes("materialization")).toEqual(false);
  expect(raw.includes("provider_env")).toEqual(false);
  const body = JSON.parse(raw) as {
    run: {
      providerResolutions?: readonly {
        status: string;
        connectionId?: string;
        ownership?: string;
        evidence?: { kind?: string; ownership?: string; connectionId?: string };
      }[];
    };
  };
  const resolution = body.run.providerResolutions?.[0];
  expect(resolution?.status).toEqual("resolved_provider_connection");
  // The public connection id is the raw connection id (the `pcn_` hashing and
  // the `ownership` axis are removed).
  expect(resolution?.ownership).toBeUndefined();
  expect(resolution?.connectionId).toEqual("penv_cf");
  expect(resolution?.evidence?.kind).toEqual("provider_connection");
  expect(resolution?.evidence?.connectionId).toEqual(resolution?.connectionId);
});

test("GET /api/v1/runs/:id does not expose legacy operator-backed ownership vocabulary", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    getRun: async (id) =>
      ({
        id,
        workspaceId: "space_a",
        capsuleId: "inst_1",
        type: "plan",
        status: "succeeded",
        createdBy: "test",
        createdAt: "2026-01-01T00:00:00Z",
        providerResolutions: [
          {
            requirement: {
              providerSource: "registry.opentofu.org/cloudflare/cloudflare",
              providerName: "cloudflare",
              modulePath: ".",
              discoveredFrom: "required_providers",
              requiredForPhases: ["plan", "apply"],
            },
            status: "resolved_provider_env",
            envId: "conn_operator_backed",
            materialization: "secret",
            evidence: {
              kind: "provider_env",
              provider: "cloudflare",
              envId: "conn_operator_backed",
              materialization: "secret",
              requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
            },
          },
        ],
      }) as Awaited<ReturnType<ControlPlaneOperations["getRun"]>>,
  });
  const { request: req, url } = request("GET", "/api/v1/runs/run_1", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const raw = await response!.text();
  // The credential-model collapse removed the `ownership` axis entirely, so the
  // legacy operator-backed ("takos_provided") vocabulary can never be exposed.
  expect(raw.includes("ownership")).toEqual(false);
  expect(raw.includes("takos_provided")).toEqual(false);
  const body = JSON.parse(raw) as {
    run: {
      providerResolutions?: readonly {
        status?: string;
        ownership?: string;
        evidence?: { kind?: string; ownership?: string };
      }[];
    };
  };
  const resolution = body.run.providerResolutions?.[0];
  expect(resolution?.status).toEqual("resolved_provider_connection");
  expect(resolution?.ownership).toBeUndefined();
  expect(resolution?.evidence?.ownership).toBeUndefined();
});

test("GET /api/v1/runs/:id returns source_sync runs for dashboard polling", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  let requestedRunId: string | undefined;
  const operations = fakeOperations({
    getRun: async (id) => {
      requestedRunId = id;
      return {
        id,
        workspaceId: "space_a",
        type: "source_sync",
        status: "running",
        sourceSnapshotId: "snap_pending",
        createdBy: "test",
        createdAt: "2026-01-01T00:00:00Z",
      } as Awaited<ReturnType<ControlPlaneOperations["getRun"]>>;
    },
  });
  const { request: req, url } = request("GET", "/api/v1/runs/ssr_1", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    run: { id: string; type: string; status: string; workspaceId: string };
  };
  expect(body.run).toMatchObject({
    id: "ssr_1",
    type: "source_sync",
    status: "running",
    workspaceId: "space_a",
  });
  expect(requestedRunId).toEqual("ssr_1");
});

test("GET /api/v1/runs/:id syncs succeeded destroy_apply runs into suspended projections", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const now = Date.now();
  store.saveLedgerAccount({
    accountId: "acct_destroy_sync",
    legalOwnerSubject: "tsub_ctrl",
    createdAt: now,
    updatedAt: now,
  });
  store.saveWorkspace({
    workspaceId: "space_a",
    accountId: "acct_destroy_sync",
    kind: "personal",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAppCapsule({
    capsuleId: "inst_destroy_sync",
    accountId: "acct_destroy_sync",
    workspaceId: "space_a",
    appId: "destroy-sync",
    sourceGitUrl: "https://github.com/example/destroy-sync",
    sourceRef: "main",
    sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    planDigest: `sha256:${"d".repeat(64)}`,
    mode: "shared-cell",
    status: "ready",
    createdBySubject: "tsub_ctrl",
    createdAt: now,
    updatedAt: now,
  });
  const operations = fakeOperations({
    getRun: async (id) =>
      ({
        id,
        workspaceId: "space_a",
        capsuleId: "inst_destroy_sync",
        type: "destroy_apply",
        status: "succeeded",
        sourceSnapshotId: "snap_destroy",
        createdBy: "system",
        createdAt: "2026-01-01T00:00:00Z",
      }) as Awaited<ReturnType<ControlPlaneOperations["getRun"]>>,
  });
  const { request: req, url } = request("GET", "/api/v1/runs/apply_destroy", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });

  expect(response?.status).toEqual(200);
  const projection = store.findAppCapsule("inst_destroy_sync");
  expect(projection?.status).toEqual("suspended");
  const events = store.listCapsuleEvents("inst_destroy_sync");
  expect(events.map((event) => event.eventType)).toContain(
    "installation.status_changed",
  );
});

test("POST /api/v1/installations/:id/destroy-plan returns 201", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/installations/inst_1/destroy-plan",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as { run: { id: string } };
  expect(body.run.id).toEqual("plan_destroy");
  expect(operations.calls.createCapsuleDestroyPlan?.[0]).toEqual({
    capsuleId: "inst_1",
    options: undefined,
  });
  expect(operations.calls.getRun).toContain("plan_destroy");
  expect(operations.calls.getRunCost).toContain("plan_destroy");
});

test("POST /api/v1/installations/:id/destroy-plan forwards runnerId to internal runner policy", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/installations/inst_1/destroy-plan",
    {
      cookie,
      body: { runnerId: "generic-opentofu-provider" },
    },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  expect(operations.calls.createCapsuleDestroyPlan?.[0]).toEqual({
    capsuleId: "inst_1",
    options: { runnerProfileId: "generic-opentofu-provider" },
  });
});

test("Capsule session routes patch status, delete via destroy-plan, drift-check, and list dependencies", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const patch = request("PATCH", "/api/v1/installations/inst_1", {
    cookie,
    body: { status: "stale" },
  });
  const patchResp = await handleControlRoute({
    request: patch.request,
    url: patch.url,
    store,
    operations,
  });
  expect(patchResp?.status).toEqual(200);
  expect(operations.calls.patchCapsuleStatus).toEqual(["inst_1", "stale"]);

  const deleteRoute = request("DELETE", "/api/v1/installations/inst_1", {
    cookie,
  });
  const deleteResp = await handleControlRoute({
    request: deleteRoute.request,
    url: deleteRoute.url,
    store,
    operations,
  });
  expect(deleteResp?.status).toEqual(202);
  expect(operations.calls.createCapsuleDestroyPlan?.[0]).toEqual({
    capsuleId: "inst_1",
    options: undefined,
  });

  const drift = request("POST", "/api/v1/installations/inst_1/drift-check", {
    cookie,
  });
  const driftResp = await handleControlRoute({
    request: drift.request,
    url: drift.url,
    store,
    operations,
  });
  expect(driftResp?.status).toEqual(201);
  expect(operations.calls.createCapsuleDriftCheck?.[0]).toEqual("inst_1");

  const dependencies = request(
    "GET",
    "/api/v1/installations/inst_1/dependencies",
    { cookie },
  );
  const dependenciesResp = await handleControlRoute({
    request: dependencies.request,
    url: dependencies.url,
    store,
    operations,
  });
  expect(dependenciesResp?.status).toEqual(200);
  expect(operations.calls.listForCapsule?.[0]).toEqual("inst_1");
});

test("DELETE /api/v1/installations/:id abandons unapplied upload-origin projections", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const now = Date.now();
  store.saveAppCapsule({
    capsuleId: "inst_upload_pending",
    accountId: "acct_upload_pending",
    workspaceId: "space_a",
    appId: "upload-pending",
    sourceGitUrl: "upload://space_a/snap_upload_pending",
    sourceRef: "upload",
    sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    planDigest: `sha256:${"d".repeat(64)}`,
    mode: "shared-cell",
    status: "installing",
    createdBySubject: "tsub_ctrl",
    createdAt: now,
    updatedAt: now,
  });
  const baseOperations = fakeOperations();
  const uploadCapsule = {
    id: "inst_upload_pending",
    workspaceId: "space_a",
    name: "upload-pending",
    slug: "upload-pending",
    installType: "opentofu_module",
    installConfigId: "cfg_upload_pending",
    environment: "prod",
    currentStateGeneration: 0,
    status: "pending",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const operations = fakeOperations({
    installations: {
      ...baseOperations.installations,
      getCapsule: async () =>
        uploadCapsule as unknown as Awaited<
          ReturnType<ControlPlaneOperations["installations"]["getCapsule"]>
        >,
      patchCapsuleStatus: async (id, status) =>
        ({
          ...uploadCapsule,
          id,
          status,
          updatedAt: "2026-01-02T00:00:00Z",
        }) as unknown as Awaited<
          ReturnType<
            ControlPlaneOperations["installations"]["patchCapsuleStatus"]
          >
        >,
    },
    createCapsuleDestroyPlan: async () => {
      const error = new Error(
        "installation inst_upload_pending is upload-origin; a plan requires a pinned upload SourceSnapshot (deploy a new upload via takosumi deploy)",
      ) as Error & { code: string };
      error.code = "failed_precondition";
      throw error;
    },
  });

  const { request: req, url } = request(
    "DELETE",
    "/api/v1/installations/inst_upload_pending",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });

  expect(response?.status).toEqual(202);
  const body = (await response!.json()) as {
    abandoned: boolean;
    installation: { status: string };
    projectionStatus: string;
  };
  expect(body.abandoned).toEqual(true);
  expect(body.installation.status).toEqual("error");
  expect(body.projectionStatus).toEqual("failed");
  expect(store.findAppCapsule("inst_upload_pending")?.status).toEqual("failed");
  expect(
    store
      .listCapsuleEvents("inst_upload_pending")
      .map((event) => event.eventType),
  ).toContain("installation.status_changed");
});

test("DELETE /api/v1/installations/:id abandons unapplied projections when destroy planning cannot resolve provider connections", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const now = Date.now();
  store.saveAppCapsule({
    capsuleId: "inst_pending_provider",
    accountId: "acct_pending_provider",
    workspaceId: "space_a",
    appId: "pending-provider",
    sourceGitUrl: "https://github.com/example/infra.git",
    sourceRef: "main",
    sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    planDigest: `sha256:${"e".repeat(64)}`,
    mode: "shared-cell",
    status: "installing",
    createdBySubject: "tsub_ctrl",
    createdAt: now,
    updatedAt: now,
  });
  const baseOperations = fakeOperations();
  const pendingCapsule = {
    id: "inst_pending_provider",
    workspaceId: "space_a",
    sourceId: "src_pending_provider",
    name: "pending-provider",
    slug: "pending-provider",
    installType: "opentofu_module",
    installConfigId: "cfg_pending_provider",
    environment: "prod",
    currentStateGeneration: 0,
    status: "pending",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const operations = fakeOperations({
    installations: {
      ...baseOperations.installations,
      getCapsule: async () =>
        pendingCapsule as unknown as Awaited<
          ReturnType<ControlPlaneOperations["installations"]["getCapsule"]>
        >,
      patchCapsuleStatus: async (id, status) =>
        ({
          ...pendingCapsule,
          id,
          status,
          updatedAt: "2026-01-02T00:00:00Z",
        }) as unknown as Awaited<
          ReturnType<
            ControlPlaneOperations["installations"]["patchCapsuleStatus"]
          >
        >,
    },
    createCapsuleDestroyPlan: async () => {
      const error = new Error(
        "Provider Env conn_missing status blocked is not ready",
      ) as Error & { code: string };
      error.code = "failed_precondition";
      throw error;
    },
  });

  const { request: req, url } = request(
    "DELETE",
    "/api/v1/installations/inst_pending_provider",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });

  expect(response?.status).toEqual(202);
  const body = (await response!.json()) as {
    abandoned: boolean;
    installation: { status: string };
    projectionStatus: string;
  };
  expect(body.abandoned).toEqual(true);
  expect(body.installation.status).toEqual("error");
  expect(body.projectionStatus).toEqual("failed");
  expect(store.findAppCapsule("inst_pending_provider")?.status).toEqual(
    "failed",
  );
});

test("POST /api/v1/installations/:id/dependencies derives workspaceId from the consumer", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/installations/inst_2/dependencies",
    {
      cookie,
      body: {
        producerCapsuleId: "inst_1",
        outputs: { db: { from: "url", to: "db", required: true } },
      },
    },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const dep = operations.calls.createDependency?.[0] as {
    consumerCapsuleId: string;
    workspaceId: string;
    mode: string;
    visibility: string;
  };
  expect(dep.consumerCapsuleId).toEqual("inst_2");
  expect(dep.workspaceId).toEqual("space_a");
  expect(dep.mode).toEqual("variable_injection");
  expect(dep.visibility).toEqual("space");
});

test("DELETE /api/v1/dependencies/:id returns 204", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "DELETE",
    "/api/v1/dependencies/dep_1",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(204);
  expect(operations.calls.deleteDependency?.[0]).toEqual("dep_1");
});

test("GET /api/v1/capsule-configs merges official + scoped", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  operations.installations.listInstallConfigs = async (workspaceId) => {
    operations.calls.listInstallConfigs ??= [];
    operations.calls.listInstallConfigs.push(workspaceId);
    if (workspaceId === "space_a") {
      return [
        {
          id: "icfg_internal",
          workspaceId: "space_a",
          name: "takos-config",
          internal: { reason: "per_install_overrides" },
          sourceKind: "generic_capsule",
          installType: "opentofu_module",
          trustLevel: "trusted",
          runnerProfileId: "generic-opentofu-provider",
          variableMapping: { project_name: "leaked" },
          outputAllowlist: {},
          policy: {},
          createdAt: "2026-01-01T00:00:01Z",
          updatedAt: "2026-01-01T00:00:01Z",
        },
        {
          id: "icfg_0123456789abcdef",
          workspaceId: "space_a",
          name: "legacy-config",
          sourceKind: "generic_capsule",
          installType: "opentofu_module",
          trustLevel: "trusted",
          variableMapping: { project_name: "old-leak" },
          outputAllowlist: {},
          policy: {},
          createdAt: "2026-01-01T00:00:02Z",
          updatedAt: "2026-01-01T00:00:02Z",
        },
      ];
    }
    return [
      {
        id: "cfg_default",
        name: "opentofu-capsule",
        sourceKind: "generic_capsule",
        installType: "opentofu_module",
        trustLevel: "trusted",
        variableMapping: {},
        outputAllowlist: {},
        policy: {},
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
  };
  const { request: req, url } = request(
    "GET",
    "/api/v1/capsule-configs?workspaceId=space_a",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    installConfigs: Array<{
      id: string;
      sourceKind?: string;
      installType?: string;
      templateBinding?: unknown;
      internal?: unknown;
      runnerId?: string;
    }>;
  };
  expect(Array.isArray(body.installConfigs)).toEqual(true);
  expect(body.installConfigs.map((config) => config.id)).toEqual([
    "cfg_default",
  ]);
  expect(body.installConfigs[0]?.sourceKind).toBe("generic_capsule");
  expect(body.installConfigs[0]?.installType).toBeUndefined();
  expect(body.installConfigs[0]?.templateBinding).toBeUndefined();
  expect(body.installConfigs[0]?.internal).toBeUndefined();
  expect(body.installConfigs[0]?.runnerId).toBeUndefined();

  const get = request("GET", "/api/v1/capsule-configs/cfg_default", {
    cookie,
  });
  const getResp = await handleControlRoute({
    request: get.request,
    url: get.url,
    store,
    operations,
  });
  expect(getResp?.status).toEqual(200);
  expect(operations.calls.getInstallConfig?.[0]).toEqual("cfg_default");
  const getBody = (await getResp!.json()) as {
    installConfig: { sourceKind?: string; installType?: string };
  };
  expect(getBody.installConfig.sourceKind).toEqual("generic_capsule");
  expect(getBody.installConfig.installType).toBeUndefined();

  const legacy = request("GET", "/api/v1/install-configs?workspaceId=space_a", {
    cookie,
  });
  const legacyResp = await handleControlRoute({
    request: legacy.request,
    url: legacy.url,
    store,
    operations,
  });
  expect(legacyResp?.status).toEqual(200);
});

test("GET /api/v1/capsule-configs starter catalog hides scoped configs", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const officialCreatedAt = "2026-01-01T00:00:00Z";
  const scopedCreatedAt = "2026-01-02T00:00:00Z";
  operations.installations.listInstallConfigs = async (workspaceId) => {
    operations.calls.listInstallConfigs ??= [];
    operations.calls.listInstallConfigs.push(workspaceId);
    if (workspaceId === "space_a") {
      return [
        {
          id: "cfg_scoped_e2e",
          workspaceId: "space_a",
          name: "ts-e2e-browser-functional-config",
          sourceKind: "generic_capsule",
          installType: "opentofu_module",
          trustLevel: "trusted",
          variableMapping: {},
          outputAllowlist: {},
          policy: {},
          catalog: {
            source: {
              git: "https://github.com/example/e2e.git",
              ref: "main",
              path: ".",
            },
            order: 1,
            surface: "service",
            kind: "worker",
            provider: "cloudflare",
            suggestedName: "test",
            badge: { ja: "テスト", en: "Test" },
            name: { ja: "E2E", en: "E2E" },
            description: { ja: "E2E", en: "E2E" },
            inputs: [],
          },
          createdAt: scopedCreatedAt,
          updatedAt: scopedCreatedAt,
        },
      ];
    }
    return [
      {
        id: "cfg-default-opentofu-capsule",
        name: "opentofu-capsule",
        sourceKind: "generic_capsule",
        installType: "opentofu_module",
        trustLevel: "trusted",
        variableMapping: {},
        outputAllowlist: {},
        policy: {},
        createdAt: officialCreatedAt,
        updatedAt: officialCreatedAt,
      },
      {
        id: "cfg-official-cloudflare-hello-worker",
        name: "cloudflare-hello-worker",
        sourceKind: "first_party_capsule",
        installType: "opentofu_module",
        trustLevel: "official",
        variableMapping: {},
        outputAllowlist: {},
        policy: {},
        catalog: {
          templateId: "cloudflare-hello-worker",
          source: {
            git: "https://github.com/tako0614/takosumi.git",
            ref: "abc123",
            path: "providers/cloudflare/modules/cloudflare-hello-worker/module",
          },
          order: 10,
          surface: "service",
          kind: "worker",
          provider: "cloudflare",
          suggestedName: "web-app",
          badge: { ja: "Webアプリ", en: "Web app" },
          name: { ja: "Webアプリを公開", en: "Publish a web app" },
          description: { ja: "Webアプリ", en: "Web app" },
          inputs: [],
        },
        templateBinding: {
          templateId: "cloudflare-hello-worker",
          templateVersion: "1.0.0",
        },
        createdAt: officialCreatedAt,
        updatedAt: officialCreatedAt,
      },
    ];
  };

  const { request: req, url } = request(
    "GET",
    "/api/v1/capsule-configs?workspaceId=space_a&view=starter-catalog",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    installConfigs: Array<{
      id: string;
      workspaceId?: string;
      catalog?: unknown;
    }>;
  };
  expect(body.installConfigs.map((config) => config.id)).toEqual([
    "cfg-default-opentofu-capsule",
    "cfg-official-cloudflare-hello-worker",
  ]);
  expect(body.installConfigs.some((config) => config.workspaceId)).toBe(false);
});

test("Sources: GET requires workspaceId, POST + sync return 201", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const missing = request("GET", "/api/v1/sources", { cookie });
  const missingResp = await handleControlRoute({
    request: missing.request,
    url: missing.url,
    store,
    operations,
  });
  expect(missingResp?.status).toEqual(400);

  const list = request("GET", "/api/v1/sources?workspaceId=space_a", {
    cookie,
  });
  const listResp = await handleControlRoute({
    request: list.request,
    url: list.url,
    store,
    operations,
  });
  expect(listResp?.status).toEqual(200);
  expect(operations.calls.listSources?.[0]).toEqual("space_a");

  const getSource = request("GET", "/api/v1/sources/src_x", { cookie });
  const getSourceResp = await handleControlRoute({
    request: getSource.request,
    url: getSource.url,
    store,
    operations,
  });
  expect(getSourceResp?.status).toEqual(200);
  expect(operations.calls.getSource?.[0]).toEqual("src_x");

  const patchSource = request("PATCH", "/api/v1/sources/src_x", {
    cookie,
    body: {
      name: "renamed",
      defaultRef: "release",
      authConnectionId: null,
    },
  });
  const patchSourceResp = await handleControlRoute({
    request: patchSource.request,
    url: patchSource.url,
    store,
    operations,
  });
  expect(patchSourceResp?.status).toEqual(200);
  expect(operations.calls.patchSource).toEqual([
    "src_x",
    {
      name: "renamed",
      defaultRef: "release",
      authConnectionId: null,
    },
  ]);

  const create = request("POST", "/api/v1/sources", {
    cookie,
    body: {
      workspaceId: "space_a",
      name: "repo",
      url: "https://example.test/r.git",
      authConnectionId: "conn_git",
    },
  });
  const createResp = await handleControlRoute({
    request: create.request,
    url: create.url,
    store,
    operations,
  });
  expect(createResp?.status).toEqual(201);
  expect(
    (operations.calls.createSource?.[0] as { authConnectionId?: string })
      .authConnectionId,
  ).toEqual("conn_git");

  const sync = request("POST", "/api/v1/sources/src_x/sync", { cookie });
  const syncResp = await handleControlRoute({
    request: sync.request,
    url: sync.url,
    store,
    operations,
  });
  expect(syncResp?.status).toEqual(201);
  expect(operations.calls.createSourceSync?.[0]).toEqual("src_x");

  const snapshots = request("GET", "/api/v1/sources/src_x/snapshots", {
    cookie,
  });
  const snapshotsResp = await handleControlRoute({
    request: snapshots.request,
    url: snapshots.url,
    store,
    operations,
  });
  expect(snapshotsResp?.status).toEqual(200);
  expect(operations.calls.listSourceSnapshots?.[0]).toEqual("src_x");
  const snapshotsBody = (await snapshotsResp!.json()) as {
    snapshots: Array<Record<string, unknown>>;
  };
  expect(snapshotsBody.snapshots[0]).toMatchObject({
    id: "snap_1",
    origin: "git",
    workspaceId: "space_a",
    sourceId: "src_x",
  });

  const compatibility = request(
    "POST",
    "/api/v1/sources/src_x/compatibility-check",
    {
      cookie,
      body: {
        sourceSnapshotId: "snap_1",
        modulePath: "deploy/opentofu",
      },
    },
  );
  const compatibilityResp = await handleControlRoute({
    request: compatibility.request,
    url: compatibility.url,
    store,
    operations,
  });
  expect(compatibilityResp?.status).toEqual(201);
  expect(operations.calls.createSourceCompatibilityCheck?.[0]).toEqual("src_x");
  expect(operations.calls.createSourceCompatibilityCheck?.[1]).toEqual({
    sourceSnapshotId: "snap_1",
    modulePath: "deploy/opentofu",
  });

  // Catalog deep-link path: a curated `installConfigId` in the body must be
  // threaded to the operations facade so a vetted first-party module is gated
  // against its own bounded allowlist (without widening the global default).
  const curated = request("POST", "/api/v1/sources/src_x/compatibility-check", {
    cookie,
    body: {
      sourceSnapshotId: "snap_1",
      installConfigId: "cfg-official-cloudflare-worker-service",
    },
  });
  const curatedResp = await handleControlRoute({
    request: curated.request,
    url: curated.url,
    store,
    operations,
  });
  expect(curatedResp?.status).toEqual(201);
  expect(operations.calls.createSourceCompatibilityCheck?.[1]).toEqual({
    sourceSnapshotId: "snap_1",
    installConfigId: "cfg-official-cloudflare-worker-service",
  });

  const unsafeModulePath = request(
    "POST",
    "/api/v1/sources/src_x/compatibility-check",
    {
      cookie,
      body: {
        sourceSnapshotId: "snap_1",
        modulePath: "../outside",
      },
    },
  );
  const unsafeModulePathResp = await handleControlRoute({
    request: unsafeModulePath.request,
    url: unsafeModulePath.url,
    store,
    operations,
  });
  expect(unsafeModulePathResp?.status).toEqual(400);

  const report = request("GET", "/api/v1/compatibility-reports/caprep_1", {
    cookie,
  });
  const reportResp = await handleControlRoute({
    request: report.request,
    url: report.url,
    store,
    operations,
  });
  expect(reportResp?.status).toEqual(200);
  expect(operations.calls.getCompatibilityReport?.[0]).toEqual("caprep_1");
});

test("Providers: catalog entries are public to session", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const providers = request("GET", "/api/v1/providers", { cookie });
  const providersResp = await handleControlRoute({
    request: providers.request,
    url: providers.url,
    store,
    operations,
  });
  expect(providersResp?.status).toEqual(200);
  expect(operations.calls.listProviderCatalogEntries).toEqual([]);
});

test("Runs: GET run, approve (session subject actor), logs, events, cancel", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie, subject } = seedSession(store);
  const operations = fakeOperations();

  const get = request("GET", "/api/v1/runs/plan_1", { cookie });
  const getResp = await handleControlRoute({
    request: get.request,
    url: get.url,
    store,
    operations,
  });
  expect(getResp?.status).toEqual(200);

  const approve = request("POST", "/api/v1/runs/plan_1/approve", {
    cookie,
    body: { approvedBy: "spoofed_actor", reason: "reviewed plan" },
  });
  const approveResp = await handleControlRoute({
    request: approve.request,
    url: approve.url,
    store,
    operations,
  });
  expect(approveResp?.status).toEqual(200);
  const approveCall = operations.calls.approveRun?.[1] as {
    approvedBy: string;
    reason?: string;
  };
  expect(approveCall).toEqual({
    approvedBy: subject,
    reason: "reviewed plan",
  });

  const logs = request("GET", "/api/v1/runs/plan_1/logs", { cookie });
  const logsResp = await handleControlRoute({
    request: logs.request,
    url: logs.url,
    store,
    operations,
  });
  expect(logsResp?.status).toEqual(200);
  expect(operations.calls.getRunLogs?.[0]).toEqual("plan_1");

  const events = request("GET", "/api/v1/runs/plan_1/events", { cookie });
  const eventsResp = await handleControlRoute({
    request: events.request,
    url: events.url,
    store,
    operations,
  });
  expect(eventsResp?.status).toEqual(200);
  expect(operations.calls.getRunEvents?.[0]).toEqual("plan_1");

  const cancel = request("POST", "/api/v1/runs/plan_1/cancel", { cookie });
  const cancelResp = await handleControlRoute({
    request: cancel.request,
    url: cancel.url,
    store,
    operations,
  });
  expect(cancelResp?.status).toEqual(200);
  expect(operations.calls.cancelRun?.[0]).toEqual("plan_1");
});

test("Runs: GET cost surfaces the public credit-shortfall projection (space-gated)", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const cost = request("GET", "/api/v1/runs/plan_1/cost", { cookie });
  const costResp = await handleControlRoute({
    request: cost.request,
    url: cost.url,
    store,
    operations,
  });
  expect(costResp?.status).toEqual(200);
  // The Run was resolved (for the space gate) then its cost projected.
  expect(operations.calls.getRun?.[0]).toEqual("plan_1");
  expect(operations.calls.getRunCost?.[0]).toEqual("plan_1");
  const body = (await costResp?.json()) as {
    cost: {
      runId: string;
      billingMode: string;
      estimatedUsdMicros: number;
      availableUsdMicros?: number;
      shortfallUsdMicros?: number;
      estimatedCredits: number;
      availableCredits?: number;
      reservationStatus?: string;
      creditShortfall?: number;
      blocked: boolean;
      reasons: readonly string[];
    };
  };
  expect(body.cost.runId).toEqual("plan_1");
  expect(body.cost.billingMode).toEqual("enforce");
  expect(body.cost.estimatedUsdMicros).toEqual(12_000_000);
  expect(body.cost.availableUsdMicros).toEqual(5_000_000);
  expect(body.cost.shortfallUsdMicros).toEqual(7_000_000);
  expect(body.cost.estimatedCredits).toEqual(12);
  expect(body.cost.availableCredits).toEqual(5);
  expect(body.cost.reservationStatus).toEqual("insufficient_credits");
  expect(body.cost.creditShortfall).toEqual(7);
  expect(body.cost.blocked).toEqual(true);
  expect(body.cost.reasons.length).toEqual(1);
});

test("Runs: GET cost is method-gated to GET", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const post = request("POST", "/api/v1/runs/plan_1/cost", { cookie });
  const postResp = await handleControlRoute({
    request: post.request,
    url: post.url,
    store,
    operations,
  });
  expect(postResp?.status).toEqual(405);
  expect(operations.calls.getRunCost).toBeUndefined();
});

test("RunGroups: plan-update, drift-check, get, approve", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const update = request("POST", "/api/v1/spaces/space_a/plan-update", {
    cookie,
  });
  const updateResp = await handleControlRoute({
    request: update.request,
    url: update.url,
    store,
    operations,
  });
  expect(updateResp?.status).toEqual(201);
  expect(operations.calls.createWorkspaceUpdate?.[0]).toEqual("space_a");

  const drift = request("POST", "/api/v1/spaces/space_a/drift-check", {
    cookie,
    body: { limit: 25 },
  });
  const driftResp = await handleControlRoute({
    request: drift.request,
    url: drift.url,
    store,
    operations,
  });
  expect(driftResp?.status).toEqual(201);
  expect(operations.calls.createWorkspaceDriftCheck).toEqual([
    "space_a",
    { limit: 25 },
  ]);

  const get = request("GET", "/api/v1/run-groups/rg_1", { cookie });
  const getResp = await handleControlRoute({
    request: get.request,
    url: get.url,
    store,
    operations,
  });
  expect(getResp?.status).toEqual(200);

  const approve = request("POST", "/api/v1/run-groups/rg_1/approve", {
    cookie,
  });
  const approveResp = await handleControlRoute({
    request: approve.request,
    url: approve.url,
    store,
    operations,
  });
  expect(approveResp?.status).toEqual(200);
});

test("Connections: requires workspaceId; provider-connections is Workspace-gated", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const missing = request("GET", "/api/v1/connections", { cookie });
  const missingResp = await handleControlRoute({
    request: missing.request,
    url: missing.url,
    store,
    operations,
  });
  expect(missingResp?.status).toEqual(400);

  const scoped = request("GET", "/api/v1/connections?workspaceId=space_a", {
    cookie,
  });
  const scopedResp = await handleControlRoute({
    request: scoped.request,
    url: scoped.url,
    store,
    operations,
  });
  expect(scopedResp?.status).toEqual(200);
  expect(operations.calls.listConnections?.[0]).toEqual("space_a");

  const defaultsMissing = request("GET", "/api/v1/provider-connections", {
    cookie,
  });
  const defaultsMissingResp = await handleControlRoute({
    request: defaultsMissing.request,
    url: defaultsMissing.url,
    store,
    operations,
  });
  expect(defaultsMissingResp?.status).toEqual(400);

  const defaults = request(
    "GET",
    "/api/v1/provider-connections?workspaceId=space_a",
    { cookie },
  );
  const defaultsResp = await handleControlRoute({
    request: defaults.request,
    url: defaults.url,
    store,
    operations,
  });
  expect(defaultsResp?.status).toEqual(200);
  expect(operations.calls.listProviderConnections).toBeDefined();
});

test("Connections create: registers a Workspace-owned connection; token never echoed", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const create = request("POST", "/api/v1/connections", {
    cookie,
    body: {
      workspaceId: "space_a",
      provider: "cloudflare",
      displayName: "本番 Cloudflare",
      // caller tries to widen to Gateway-backed operator coverage; ignore it.
      scope: "operator",
      values: {
        CLOUDFLARE_API_TOKEN: "super-secret-token-value",
        CLOUDFLARE_ACCOUNT_ID: "acct_dashboard",
      },
    },
  });
  const response = await handleControlRoute({
    request: create.request,
    url: create.url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);

  // The facade was called with a Workspace-scoped cloudflare_api_token request.
  const passed = operations.calls.createConnection?.[0] as {
    workspaceId?: string;
    provider?: string;
    kind?: string;
    scope?: string;
    scopeHints?: { accountId?: string };
    values?: Record<string, string>;
  };
  expect(passed.workspaceId).toEqual("space_a");
  expect(passed.provider).toEqual("cloudflare");
  expect(passed.kind).toEqual("cloudflare_api_token");
  // Forced Workspace scope regardless of the caller-supplied `scope: "operator"`.
  expect(passed.scope).toEqual("space");
  expect(passed.scopeHints?.accountId).toEqual("acct_dashboard");
  // The write-only token reaches the facade…
  expect(passed.values?.CLOUDFLARE_API_TOKEN).toEqual(
    "super-secret-token-value",
  );

  // …but is NEVER present in the HTTP response body.
  const text = await response!.text();
  expect(text).not.toContain("super-secret-token-value");
  expect(text).not.toContain("CLOUDFLARE_API_TOKEN");
});

test("Connections create: registers a Workspace-owned source Git HTTPS token; token never echoed", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const create = request("POST", "/api/v1/connections", {
    cookie,
    body: {
      workspaceId: "space_a",
      provider: "ignored-provider",
      kind: "source_git_https_token",
      displayName: "private source",
      scope: "operator",
      scopeHints: {
        repoUrl: "https://github.com/example/private.git",
        username: "git",
      },
      values: {
        GIT_HTTPS_TOKEN: "ghp-private-source-token",
      },
    },
  });
  const response = await handleControlRoute({
    request: create.request,
    url: create.url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);

  const passed = operations.calls.createConnection?.[0] as {
    workspaceId?: string;
    provider?: string;
    kind?: string;
    scope?: string;
    scopeHints?: { repoUrl?: string; username?: string };
    values?: Record<string, string>;
  };
  expect(passed.workspaceId).toEqual("space_a");
  expect(passed.provider).toEqual("source_git_https_token");
  expect(passed.kind).toEqual("source_git_https_token");
  expect(passed.scope).toEqual("space");
  expect(passed.scopeHints).toEqual({
    repoUrl: "https://github.com/example/private.git",
    username: "git",
  });
  expect(passed.values?.GIT_HTTPS_TOKEN).toEqual("ghp-private-source-token");

  const text = await response!.text();
  expect(text).not.toContain("ghp-private-source-token");
  expect(text).not.toContain("GIT_HTTPS_TOKEN");
});

test("Connections create: normalizes Google Cloud to service-account JSON driver", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const serviceAccountJson = JSON.stringify({
    type: "service_account",
    project_id: "project-1",
    client_email: "svc@project-1.iam.gserviceaccount.com",
    private_key:
      "-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----\\n",
  });

  const create = request("POST", "/api/v1/connections", {
    cookie,
    body: {
      workspaceId: "space_a",
      provider: "gcp",
      displayName: "Google Cloud",
      values: {
        GOOGLE_CREDENTIALS: serviceAccountJson,
        GOOGLE_CLOUD_PROJECT: "project-1",
      },
    },
  });
  const response = await handleControlRoute({
    request: create.request,
    url: create.url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);

  const passed = operations.calls.createConnection?.[0] as {
    workspaceId?: string;
    provider?: string;
    kind?: string;
    scope?: string;
    scopeHints?: { gcpProjectId?: string };
    values?: Record<string, string>;
  };
  expect(passed.workspaceId).toEqual("space_a");
  expect(passed.provider).toEqual("google");
  expect(passed.kind).toEqual("gcp_service_account_json");
  expect(passed.scope).toEqual("space");
  expect(passed.scopeHints?.gcpProjectId).toEqual("project-1");
  expect(passed.values?.GOOGLE_CREDENTIALS).toEqual(serviceAccountJson);

  const text = await response!.text();
  expect(text).not.toContain("private_key");
  expect(text).not.toContain("BEGIN PRIVATE KEY");
});

test("Connections create: registers arbitrary OpenTofu provider env values", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const provider = "registry.opentofu.org/snowflake-labs/snowflake";

  const create = request("POST", "/api/v1/connections", {
    cookie,
    body: {
      workspaceId: "space_a",
      provider,
      displayName: "Snowflake",
      values: {
        SNOWFLAKE_ACCOUNT: "acct",
        SNOWFLAKE_USER: "svc",
        SNOWFLAKE_PASSWORD: "snowflake-secret",
      },
    },
  });
  const response = await handleControlRoute({
    request: create.request,
    url: create.url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);

  const passed = operations.calls.createConnection?.[0] as {
    workspaceId?: string;
    provider?: string;
    kind?: string;
    scope?: string;
    values?: Record<string, string>;
  };
  expect(passed.workspaceId).toEqual("space_a");
  expect(passed.provider).toEqual(provider);
  expect(passed.kind).toEqual("generic_env_provider");
  expect(passed.scope).toEqual("space");
  expect(passed.values?.SNOWFLAKE_PASSWORD).toEqual("snowflake-secret");

  const text = await response!.text();
  expect(text).not.toContain("snowflake-secret");
  expect(text).not.toContain("SNOWFLAKE_PASSWORD");
});

test("Connections create: forwards generic env credential files without echoing secrets", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const provider = "registry.opentofu.org/example/envfile";

  const create = request("POST", "/api/v1/connections", {
    cookie,
    body: {
      workspaceId: "space_a",
      provider,
      kind: "generic_env_provider",
      displayName: "Env file provider",
      values: {
        GENERIC_API_TOKEN: "generic-secret",
      },
      files: [
        {
          path: "provider-credentials.json",
          content: '{"token":"file-secret"}',
          envName: "GENERIC_CREDENTIALS_FILE",
          mode: 0o600,
        },
      ],
    },
  });
  const response = await handleControlRoute({
    request: create.request,
    url: create.url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);

  const passed = operations.calls.createConnection?.[0] as {
    provider?: string;
    kind?: string;
    values?: Record<string, string>;
    files?: Array<{
      path: string;
      content: string;
      envName?: string;
      mode?: number;
    }>;
  };
  expect(passed.provider).toEqual(provider);
  expect(passed.kind).toEqual("generic_env_provider");
  expect(passed.values?.GENERIC_API_TOKEN).toEqual("generic-secret");
  expect(passed.files).toEqual([
    {
      path: "provider-credentials.json",
      content: '{"token":"file-secret"}',
      envName: "GENERIC_CREDENTIALS_FILE",
      mode: 0o600,
    },
  ]);

  const text = await response!.text();
  expect(text).not.toContain("generic-secret");
  expect(text).not.toContain("file-secret");
});

test("Connections create: rejects credential files for fixed provider helpers", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const create = request("POST", "/api/v1/connections", {
    cookie,
    body: {
      workspaceId: "space_a",
      provider: "cloudflare",
      values: {
        CLOUDFLARE_API_TOKEN: "cf-secret",
      },
      files: [
        {
          path: "cloudflare.json",
          content: '{"token":"file-secret"}',
          envName: "CLOUDFLARE_CREDENTIALS_FILE",
        },
      ],
    },
  });
  const response = await handleControlRoute({
    request: create.request,
    url: create.url,
    store,
    operations,
  });
  expect(response?.status).toEqual(400);
  expect(operations.calls.createConnection).toBeUndefined();
  const text = await response!.text();
  expect(text).not.toContain("cf-secret");
  expect(text).not.toContain("file-secret");
  expect(JSON.parse(text).error.message).toContain("generic env");
});

test("Connections create: known non-Cloudflare providers are explicit generic env, not compat endpoints", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const create = request("POST", "/api/v1/connections", {
    cookie,
    body: {
      workspaceId: "space_a",
      provider: "aws",
      displayName: "AWS production",
      values: {
        AWS_ACCESS_KEY_ID: "key",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        AWS_REGION: "ap-northeast-1",
      },
    },
  });
  const response = await handleControlRoute({
    request: create.request,
    url: create.url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);

  const passed = operations.calls.createConnection?.[0] as {
    provider?: string;
    kind?: string;
    scope?: string;
    values?: Record<string, string>;
  };
  expect(passed.provider).toEqual("aws");
  expect(passed.kind).toEqual("generic_env_provider");
  expect(passed.scope).toEqual("space");
  expect(passed.values?.AWS_REGION).toEqual("ap-northeast-1");

  const text = await response!.text();
  expect(text).not.toContain("aws-secret");
});

test("Connections create: honors explicit generic env for guided providers", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const create = request("POST", "/api/v1/connections", {
    cookie,
    body: {
      workspaceId: "space_a",
      provider: "cloudflare",
      kind: "generic_env_provider",
      values: {
        CLOUDFLARE_API_TOKEN: "cf-secret-token",
        CLOUDFLARE_ACCOUNT_ID: "acct",
        CLOUDFLARE_CUSTOM_ENDPOINT: "https://cloudflare.example.test",
      },
    },
  });
  const response = await handleControlRoute({
    request: create.request,
    url: create.url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);

  const passed = operations.calls.createConnection?.[0] as {
    provider?: string;
    kind?: string;
    scope?: string;
    values?: Record<string, string>;
  };
  expect(passed.provider).toEqual("cloudflare");
  expect(passed.kind).toEqual("generic_env_provider");
  expect(passed.scope).toEqual("space");
  expect(passed.values?.CLOUDFLARE_CUSTOM_ENDPOINT).toEqual(
    "https://cloudflare.example.test",
  );

  const text = await response!.text();
  expect(text).not.toContain("cf-secret-token");
  expect(text).not.toContain("cloudflare.example.test");
});

test("Connections create: requires workspaceId and values", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const noWorkspace = request("POST", "/api/v1/connections", {
    cookie,
    body: { provider: "cloudflare", values: { CLOUDFLARE_API_TOKEN: "t" } },
  });
  const noWorkspaceResp = await handleControlRoute({
    request: noWorkspace.request,
    url: noWorkspace.url,
    store,
    operations,
  });
  expect(noWorkspaceResp?.status).toEqual(400);

  const noValues = request("POST", "/api/v1/connections", {
    cookie,
    body: { workspaceId: "space_a", provider: "cloudflare", values: {} },
  });
  const noValuesResp = await handleControlRoute({
    request: noValues.request,
    url: noValues.url,
    store,
    operations,
  });
  expect(noValuesResp?.status).toEqual(400);

  const noProvider = request("POST", "/api/v1/connections", {
    cookie,
    body: {
      workspaceId: "space_a",
      values: { CLOUDFLARE_API_TOKEN: "t" },
    },
  });
  const noProviderResp = await handleControlRoute({
    request: noProvider.request,
    url: noProvider.url,
    store,
    operations,
  });
  expect(noProviderResp?.status).toEqual(400);
  await expect(noProviderResp!.json()).resolves.toMatchObject({
    error: {
      code: "invalid_request",
      message: "provider is required",
    },
  });

  const sourceNoToken = request("POST", "/api/v1/connections", {
    cookie,
    body: {
      workspaceId: "space_a",
      kind: "source_git_https_token",
      values: { OTHER_SECRET: "not-a-git-token" },
    },
  });
  const sourceNoTokenResp = await handleControlRoute({
    request: sourceNoToken.request,
    url: sourceNoToken.url,
    store,
    operations,
  });
  expect(sourceNoTokenResp?.status).toEqual(400);

  // Neither malformed request reached the facade.
  expect(operations.calls.createConnection).toBeUndefined();
});

test("Connections create: another Workspace is forbidden (no connection minted)", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      getWorkspace: async (id) => ({
        id,
        handle: "other",
        displayName: "Other",
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
  });
  const create = request("POST", "/api/v1/connections", {
    cookie,
    body: {
      workspaceId: "space_b",
      provider: "cloudflare",
      values: { CLOUDFLARE_API_TOKEN: "secret" },
    },
  });
  const response = await handleControlRoute({
    request: create.request,
    url: create.url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  // The space gate runs BEFORE any create — no secret ever reaches the facade.
  expect(operations.calls.createConnection).toBeUndefined();
});

test("Cloudflare OAuth: 501 when the operator has not wired the helper", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const start = request("POST", "/api/v1/connections/cloudflare/oauth/start", {
    cookie,
    body: { workspaceId: "space_a" },
  });
  const startResp = await handleControlRoute({
    request: start.request,
    url: start.url,
    store,
    operations,
  });
  expect(startResp?.status).toEqual(501);

  const callback = request(
    "GET",
    "/api/v1/connections/cloudflare/oauth/callback?code=c&state=s",
    { cookie },
  );
  const callbackResp = await handleControlRoute({
    request: callback.request,
    url: callback.url,
    store,
    operations,
  });
  expect(callbackResp?.status).toEqual(501);
});

test("POST /api/v1/connections/:id/test resolves the Workspace and re-verifies the connection", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/connections/conn_abc/test",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { status: string };
  expect(body.status).toEqual("verified");
  // Ownership is resolved from the Connection's workspaceId before the test runs.
  expect(operations.calls.getConnection).toEqual(["conn_abc"]);
  expect(operations.calls.testConnection).toEqual(["conn_abc"]);
});

test("POST /api/v1/connections/:id/revoke deletes the connection and answers 204", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/connections/conn_abc/revoke",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(204);
  expect(operations.calls.revokeConnection).toEqual(["conn_abc"]);
});

test("POST /api/v1/connections/:id/revoke accepts the raw connection id as the public ProviderConnection id", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // After the credential-model collapse the public ProviderConnection id IS the
  // raw connection id (the `pcn_` hashing + secretRef-backed indirection are
  // removed), so revoke resolves ownership directly through getConnection.
  const connectionId = "conn_cf";
  const getConnectionCalls: string[] = [];
  const operations = fakeOperations({
    getConnection: async (id) => {
      getConnectionCalls.push(id);
      return {
        id,
        workspaceId: "space_a",
        provider: "cloudflare",
        providerSource: "registry.opentofu.org/cloudflare/cloudflare",
        kind: "cloudflare_api_token",
        scope: "space",
        status: "verified",
        materialization: "secret",
        envNames: ["CLOUDFLARE_API_TOKEN"],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["getConnection"]>
      >;
    },
  });
  const { request: req, url } = request(
    "POST",
    `/api/v1/connections/${connectionId}/revoke`,
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });

  expect(response?.status).toEqual(204);
  expect(getConnectionCalls).toEqual(["conn_cf"]);
  expect(operations.calls.revokeConnection).toEqual(["conn_cf"]);
});

test("POST /api/v1/connections/:id/revoke 404s (non-disclosing) for an unknown connection id", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // An unresolvable connection id answers a non-disclosing 404 and never revokes.
  const notFound = Object.assign(new Error("not found"), {
    code: "not_found",
  });
  const getConnectionCalls: string[] = [];
  const operations = fakeOperations({
    getConnection: async (id) => {
      getConnectionCalls.push(id);
      throw notFound;
    },
  });
  const { request: req, url } = request(
    "POST",
    `/api/v1/connections/conn_unknown/revoke`,
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });

  expect(response?.status).toEqual(404);
  expect(getConnectionCalls).toEqual(["conn_unknown"]);
  expect(operations.calls.revokeConnection).toBeUndefined();
});

test("POST /api/v1/connections/:id/revoke 404s (non-disclosing) for a Workspace the caller does not own", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The Connection belongs to a Workspace owned by a different subject -> the
  // ownership gate must answer a non-disclosing connection_not_found, and the
  // revoke must never run.
  const operations = fakeOperations({
    getConnection: async (connectionId) =>
      ({
        id: connectionId,
        workspaceId: "space_foreign",
        provider: "cloudflare",
        kind: "cloudflare_api_token",
        authMethod: "static_secret",
        scope: "space",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }) as unknown as ReturnType<ControlPlaneOperations["getConnection"]>,
    spaces: {
      getWorkspace: async (id) => ({
        id,
        handle: id,
        displayName: id,
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/connections/conn_foreign/revoke",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(404);
  const body = (await response!.json()) as { error: { code: string } };
  expect(body.error.code).toEqual("connection_not_found");
  expect(operations.calls.revokeConnection).toBeUndefined();
});

test("Cloudflare OAuth: start authorizes and callback redirects to /connections, minting a Workspace-owned connection", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie, subject } = seedSession(store);
  // Record the subject the cookie-gated start signed into the state, then the
  // cross-site callback replays it back through `complete` (mirroring the real
  // HMAC-signed state, which carries the subject across the redirect).
  let signedSubject: string | undefined;
  const operations = fakeOperations({
    connectionOAuth: {
      cloudflare: {
        start: async (input) => {
          signedSubject = input.subject;
          return {
            authorizationUrl:
              "https://dash.cloudflare.com/oauth2/auth?client_id=cf&state=signed&space=" +
              encodeURIComponent(input.workspaceId),
            state: "signed",
          };
        },
        complete: async () => ({
          request: {
            workspaceId: "space_a",
            provider: "cloudflare",
            kind: "generic_env_provider" as const,
            authMethod: "static_secret" as const,
            values: { CLOUDFLARE_API_TOKEN: "minted-oauth-token" },
          },
          subject: signedSubject,
        }),
      },
    },
  });

  const start = request("POST", "/api/v1/connections/cloudflare/oauth/start", {
    cookie,
    body: { workspaceId: "space_a" },
  });
  const startResp = await handleControlRoute({
    request: start.request,
    url: start.url,
    store,
    operations,
  });
  expect(startResp?.status).toEqual(200);
  const startBody = (await startResp!.json()) as { authorizationUrl: string };
  expect(startBody.authorizationUrl).toContain("dash.cloudflare.com");
  // The authenticated subject is bound into the OAuth state at start time.
  expect(signedSubject).toEqual(subject);

  // The callback arrives via a top-level CROSS-SITE redirect: NO session cookie
  // (SameSite=Strict does not ride it) and NO Authorization header. The flow
  // must still complete by authorizing from the signed state's subject.
  const callback = request(
    "GET",
    "/api/v1/connections/cloudflare/oauth/callback?code=cf-code&state=signed",
  );
  const callbackResp = await handleControlRoute({
    request: callback.request,
    url: callback.url,
    store,
    operations,
  });
  // Backend route redirects to the dashboard /connections screen (no SPA route).
  expect(callbackResp?.status).toEqual(303);
  const location = callbackResp!.headers.get("location") ?? "";
  expect(location).toContain("/connections");
  expect(location).toContain("connected=1");
  expect(location).toContain("connection_id=conn_new");
  expect(location).toContain("connection_status=verified");
  // The minted token never rides the redirect query.
  expect(location).not.toContain("minted-oauth-token");

  // A Workspace-owned connection was created from the OAuth result.
  const passed = operations.calls.createConnection?.[0] as {
    workspaceId?: string;
    scope?: string;
  };
  expect(passed.workspaceId).toEqual("space_a");
  expect(passed.scope).toEqual("space");
  expect(operations.calls.testConnection).toEqual(["conn_new"]);
});

test("Cloudflare OAuth callback without the session cookie still completes (cross-site redirect)", async () => {
  // Regression guard for the SameSite=Strict gap: a browser following the
  // dash.cloudflare.com -> worker redirect sends neither header nor cookie.
  // Before the fix the up-front requireAccountSession returned 401 JSON and the
  // user never reached /connections. The callback must authorize from the
  // signed state subject alone.
  const store = new InMemoryAccountsStore();
  // The owning account exists, but we deliberately present NO cookie.
  seedSession(store, { subject: "tsub_ctrl" });
  const operations = fakeOperations({
    connectionOAuth: {
      cloudflare: {
        start: async () => ({ authorizationUrl: "https://x", state: "signed" }),
        complete: async () => ({
          request: {
            workspaceId: "space_a",
            provider: "cloudflare",
            kind: "generic_env_provider" as const,
            authMethod: "static_secret" as const,
            values: { CLOUDFLARE_API_TOKEN: "minted" },
          },
          subject: "tsub_ctrl",
        }),
      },
    },
  });
  const callback = request(
    "GET",
    "/api/v1/connections/cloudflare/oauth/callback?code=cf-code&state=signed",
    // NO cookie header on purpose: this is the cross-site case.
  );
  const response = await handleControlRoute({
    request: callback.request,
    url: callback.url,
    store,
    operations,
  });
  // NOT a 401 JSON — a real 303 redirect back to the dashboard.
  expect(response?.status).toEqual(303);
  const location = response!.headers.get("location") ?? "";
  expect(location).toContain("/connections");
  expect(location).toContain("connected=1");
  expect(location).toContain("connection_id=conn_new");
  expect(location).toContain("connection_status=verified");
  const passed = operations.calls.createConnection?.[0] as { scope?: string };
  expect(passed.scope).toEqual("space");
  expect(operations.calls.testConnection).toEqual(["conn_new"]);
});

test("Cloudflare OAuth callback: an unsigned state (no subject) is refused", async () => {
  // A forged/legacy callback whose state carries no signed subject must not be
  // trusted to mint a Connection, even though the workspaceId looks owned.
  const store = new InMemoryAccountsStore();
  seedSession(store, { subject: "tsub_ctrl" });
  const operations = fakeOperations({
    connectionOAuth: {
      cloudflare: {
        start: async () => ({ authorizationUrl: "https://x", state: "signed" }),
        complete: async () => ({
          request: {
            workspaceId: "space_a",
            provider: "cloudflare",
            kind: "generic_env_provider" as const,
            authMethod: "static_secret" as const,
            values: { CLOUDFLARE_API_TOKEN: "minted" },
          },
          // subject intentionally absent (unsigned/legacy state).
        }),
      },
    },
  });
  const callback = request(
    "GET",
    "/api/v1/connections/cloudflare/oauth/callback?code=cf-code&state=signed",
  );
  const response = await handleControlRoute({
    request: callback.request,
    url: callback.url,
    store,
    operations,
  });
  expect(response?.status).toEqual(303);
  const location = response!.headers.get("location") ?? "";
  expect(location).toContain("connection_error=oauth_failed");
  expect(operations.calls.createConnection).toBeUndefined();
});

test("Cloudflare OAuth callback: a Workspace the signed subject does not own is not minted", async () => {
  const store = new InMemoryAccountsStore();
  // Present a cookie too, to prove the gate is the SIGNED subject, not the
  // cookie: the signed subject does not own the Workspace, so the mint is refused.
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      getWorkspace: async (id) => ({
        id,
        handle: "other",
        displayName: "Other",
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
    connectionOAuth: {
      cloudflare: {
        start: async () => ({ authorizationUrl: "https://x", state: "s" }),
        complete: async () => ({
          request: {
            // The signed state resolves to a Workspace owned by someone else.
            workspaceId: "space_b",
            provider: "cloudflare",
            kind: "generic_env_provider" as const,
            authMethod: "static_secret" as const,
            values: { CLOUDFLARE_API_TOKEN: "minted" },
          },
          // The signed subject is the session subject, who does NOT own space_b.
          subject: "tsub_ctrl",
        }),
      },
    },
  });
  const callback = request(
    "GET",
    "/api/v1/connections/cloudflare/oauth/callback?code=cf-code&state=signed",
    { cookie },
  );
  const response = await handleControlRoute({
    request: callback.request,
    url: callback.url,
    store,
    operations,
  });
  // Redirect carries an opaque error; no connection is minted cross-tenant.
  expect(response?.status).toEqual(303);
  const location = response!.headers.get("location") ?? "";
  expect(location).toContain("connection_error=forbidden");
  expect(operations.calls.createConnection).toBeUndefined();
});

test("OutputShares: list, create, approve, and revoke are Workspace-gated", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie, subject } = seedSession(store);
  seedLedgerWorkspace(store, {
    subject,
    accountId: "acct_to",
    workspaceId: "space_b",
  });
  const operations = fakeOperations();

  const list = request("GET", "/api/v1/output-shares?workspaceId=space_a", {
    cookie,
  });
  const listResp = await handleControlRoute({
    request: list.request,
    url: list.url,
    store,
    operations,
  });
  expect(listResp?.status).toEqual(200);
  expect(operations.calls.listOutputShares?.[0]).toEqual("space_a");

  const create = request("POST", "/api/v1/output-shares", {
    cookie,
    body: {
      fromWorkspaceId: "space_a",
      toWorkspaceId: "space_b",
      producerCapsuleId: "inst_1",
      outputs: [{ name: "domain", alias: "base_domain", sensitive: true }],
      sensitivePolicy: { allow: true, reason: "approved by both spaces" },
    },
  });
  const createResp = await handleControlRoute({
    request: create.request,
    url: create.url,
    store,
    operations,
  });
  expect(createResp?.status).toEqual(201);
  expect(
    (
      operations.calls.createOutputShare?.[0] as {
        outputs: Array<{ alias?: string; sensitive?: boolean }>;
        sensitivePolicy?: { allow: boolean; reason?: string };
      }
    ).outputs[0]?.alias,
  ).toEqual("base_domain");
  expect(
    (
      operations.calls.createOutputShare?.[0] as {
        outputs: Array<{ alias?: string; sensitive?: boolean }>;
        sensitivePolicy?: { allow: boolean; reason?: string };
      }
    ).outputs[0]?.sensitive,
  ).toBe(true);
  expect(
    (
      operations.calls.createOutputShare?.[0] as {
        outputs: Array<{ alias?: string; sensitive?: boolean }>;
        sensitivePolicy?: { allow: boolean; reason?: string };
      }
    ).sensitivePolicy,
  ).toEqual({ allow: true, reason: "approved by both spaces" });

  const approve = request("POST", "/api/v1/output-shares/oshare_1/approve", {
    cookie,
  });
  const approveResp = await handleControlRoute({
    request: approve.request,
    url: approve.url,
    store,
    operations,
  });
  expect(approveResp?.status).toEqual(200);
  expect(operations.calls.approveOutputShare?.[0]).toEqual("oshare_1");

  const revoke = request("POST", "/api/v1/output-shares/oshare_1/revoke", {
    cookie,
  });
  const revokeResp = await handleControlRoute({
    request: revoke.request,
    url: revoke.url,
    store,
    operations,
  });
  expect(revokeResp?.status).toEqual(200);
  expect(operations.calls.revokeOutputShare?.[0]).toEqual("oshare_1");
});

test("controller errors map to their HTTP status (not_found -> 404)", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    installations: {
      getCapsule: async () => {
        throw Object.assign(new Error("nope"), { code: "not_found" });
      },
      listCapsules: async () => [],
      listCapsulesPage: async () => ({ items: [] }),
      createCapsule: async () => {
        throw new Error("unused");
      },
      listInstallConfigs: async () => [],
      putCapsuleProviderEnvBindingSet: async (profile) => profile,
      getCapsuleProviderEnvBindingSetByCapsule: async () => undefined,
    },
  });
  const { request: req, url } = request(
    "GET",
    "/api/v1/installations/inst_missing",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(404);
  const body = (await response!.json()) as { error: { code: string } };
  expect(body.error.code).toEqual("not_found");
});

test("unknown control subpath is 404 after the session gate", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/api/v1/nope", { cookie });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(404);
});

// --- personalWorkspaceHandle derivation ---------------------------------------

test("personalWorkspaceHandle prefers displayName, then email, then fallback", () => {
  expect(
    personalWorkspaceHandle({
      subject: "tsub_x",
      displayName: "Shota Tomiyama",
    }),
  ).toEqual("shota-tomiyama");
  expect(
    personalWorkspaceHandle({
      subject: "tsub_x",
      email: "alice.dev@example.com",
    }),
  ).toEqual("alice-dev");
  // Unusable displayName ("!") falls through to email.
  expect(
    personalWorkspaceHandle({
      subject: "tsub_x",
      displayName: "!",
      email: "bob@x.io",
    }),
  ).toEqual("bob");
  // No usable candidate -> u-<short subject>.
  const fallback = personalWorkspaceHandle({ subject: "tsub_AbCdEf123" });
  expect(fallback.startsWith("u-")).toEqual(true);
  expect(/^[a-z0-9][a-z0-9-]{1,38}$/.test(fallback)).toEqual(true);
});

test("personalWorkspaceHandle clamps to the 39-char handle rule", () => {
  const long = "x".repeat(80);
  const handle = personalWorkspaceHandle({
    subject: "tsub_x",
    displayName: long,
  });
  expect(handle.length).toBeLessThanOrEqual(39);
  expect(/^[a-z0-9][a-z0-9-]{1,38}$/.test(handle)).toEqual(true);
});

// --- ensurePersonalWorkspace fire-and-forget hook -----------------------------

test("maybeEnsurePersonalWorkspaceForSession creates a space for a live session", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store, { displayName: "Shota" });
  const operations = fakeOperations();
  const { request: req } = request("GET", "/v1/account/session/me", { cookie });
  await maybeEnsurePersonalWorkspaceForSession({
    request: req,
    store,
    operations,
  });
  const createCall = operations.calls.createWorkspace?.[0] as {
    handle: string;
    type: string;
    ownerUserId: string;
  };
  expect(createCall.handle).toEqual("shota");
  expect(createCall.type).toEqual("personal");
  expect(createCall.ownerUserId).toEqual("tsub_ctrl");
});

test("maybeEnsurePersonalWorkspaceForSession swallows a handle-collision error", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store, { displayName: "Shota" });
  const operations = fakeOperations({
    spaces: {
      listWorkspaces: async () => [],
      getWorkspace: async () => {
        throw new Error("unused");
      },
      createWorkspace: async () => {
        throw Object.assign(new Error("taken"), {
          code: "failed_precondition",
        });
      },
    },
  });
  const { request: req } = request("GET", "/v1/account/session/me", { cookie });
  // Must NOT throw.
  await maybeEnsurePersonalWorkspaceForSession({
    request: req,
    store,
    operations,
  });
});

test("maybeEnsurePersonalWorkspaceForSession is a no-op without a session", async () => {
  const store = new InMemoryAccountsStore();
  const operations = fakeOperations();
  const { request: req } = request("GET", "/v1/account/session/me");
  await maybeEnsurePersonalWorkspaceForSession({
    request: req,
    store,
    operations,
  });
  expect(operations.calls.createWorkspace).toBeUndefined();
});

// --- POST /api/v1/runs/:runId/apply (§31 GUI deploy) ----------------------

test("POST /api/v1/runs/:id/apply applies a succeeded plan for an owned Workspace", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("POST", "/api/v1/runs/plan_1/apply", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as { run: { id: string } };
  expect(body.run.id).toEqual("apply_1");
  // The plan run is resolved (for the space gate) before the apply is created.
  expect(operations.calls.getPlanRun).toEqual(["plan_1"]);
  const applyArg = operations.calls.createApplyRun?.[0] as {
    planRunId: string;
    confirmDestructive?: boolean;
    expected: {
      planRunId: string;
      planDigest: string;
      resolvedProviderEnvBindingsDigest?: string;
    };
  };
  expect(applyArg.planRunId).toEqual("plan_1");
  // A non-destructive apply does not send the confirmation flag.
  expect(applyArg.confirmDestructive).toBeUndefined();
  // The expected guard is rebuilt server-side from the reviewed plan.
  expect(applyArg.expected.planRunId).toEqual("plan_1");
  expect(applyArg.expected.planDigest).toEqual(`sha256:${"d".repeat(64)}`);
  expect(applyArg.expected.resolvedProviderEnvBindingsDigest).toEqual(
    `sha256:${"f".repeat(64)}`,
  );
});

test("POST /api/v1/runs/:id/apply projects installation and deployment handles", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    createApplyRun: async (req) =>
      ({
        applyRun: {
          id: "apply_1",
          planRunId: req.planRunId,
          workspaceId: "space_a",
          status: "queued",
        },
        installation: {
          id: "inst_1",
          workspaceId: "space_a",
          name: "app",
          slug: "app",
          sourceId: "src_x",
          installType: "opentofu_module",
          installConfigId: "cfg_x",
          environment: "prod",
          currentDeploymentId: "dep_1",
          currentStateGeneration: 4,
          currentOutputId: "osnap_secret_1",
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        deployment: deploymentRow("dep_1", "space_a", "inst_1"),
      }) as unknown as Awaited<
        ReturnType<ControlPlaneOperations["createApplyRun"]>
      >,
  });
  const { request: req, url } = request("POST", "/api/v1/runs/plan_1/apply", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as {
    installation?: Record<string, unknown>;
    deployment?: Record<string, unknown>;
  };
  expect(body.installation?.installType).toBeUndefined();
  expect(body.installation?.currentOutputId).toBeUndefined();
  expect(body.deployment?.outputSnapshotId).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain("osnap_secret_1");
});

test("POST /api/v1/runs/:id/apply forwards confirmDestructive for a destructive plan", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("POST", "/api/v1/runs/plan_1/apply", {
    cookie,
    body: { confirmDestructive: true },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as { run: { id: string } };
  expect(body.run.id).toEqual("apply_1");
  const applyArg = operations.calls.createApplyRun?.[0] as {
    confirmDestructive?: boolean;
  };
  expect(applyArg.confirmDestructive).toEqual(true);
});

test("POST /api/v1/runs/:id/apply rejects a plan from another inaccessible Workspace", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listWorkspaces: async () => [],
      // The plan's owning Workspace (space_b) is owned by a different subject.
      getWorkspace: async (id) => ({
        id,
        handle: "other",
        displayName: "Other",
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
    getPlanRun: async (id) =>
      ({
        planRun: {
          id,
          workspaceId: "space_b",
          status: "succeeded",
          operation: "create",
          runnerProfileId: "rp_default",
          sourceDigest: `sha256:${"a".repeat(64)}`,
          variablesDigest: `sha256:${"b".repeat(64)}`,
          policyDecisionDigest: `sha256:${"c".repeat(64)}`,
          policy: { status: "passed" },
          planDigest: `sha256:${"d".repeat(64)}`,
          planArtifact: { kind: "object-storage", ref: "k", digest: "e" },
        },
      }) as unknown as Awaited<
        ReturnType<ControlPlaneOperations["getPlanRun"]>
      >,
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/runs/plan_other/apply",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  // The plan was resolved (to learn its Workspace, space_b) but the gate rejects
  // before any apply is created.
  expect(operations.calls.createApplyRun).toBeUndefined();
});

test("POST /api/v1/runs/:id/apply surfaces the controller failed_precondition for an unfinished plan", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    createApplyRun: async () => {
      throw Object.assign(
        new Error(
          "plan run plan_1 is running; apply requires a succeeded plan",
        ),
        { code: "failed_precondition" },
      );
    },
  });
  const { request: req, url } = request("POST", "/api/v1/runs/plan_1/apply", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(409);
  const body = (await response?.json()) as { error?: { code?: string } };
  expect(body.error?.code).toEqual("failed_precondition");
});

test("POST /api/v1/runs/:id/apply surfaces failed_precondition when the plan was already applied", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    createApplyRun: async () => {
      throw Object.assign(
        new Error(
          "plan run plan_1 has already been applied by apply run apply_1",
        ),
        { code: "failed_precondition" },
      );
    },
  });
  const { request: req, url } = request("POST", "/api/v1/runs/plan_1/apply", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(409);
});

test("POST /api/v1/runs/:id rejects a non-apply leaf and the wrong method", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const notApply = request("POST", "/api/v1/runs/plan_1/bogus", {
    cookie,
  });
  expect(
    (
      await handleControlRoute({
        request: notApply.request,
        url: notApply.url,
        store,
        operations,
      })
    )?.status,
  ).toEqual(404);
  const wrongMethod = request("GET", "/api/v1/runs/plan_1/apply", {
    cookie,
  });
  expect(
    (
      await handleControlRoute({
        request: wrongMethod.request,
        url: wrongMethod.url,
        store,
        operations,
      })
    )?.status,
  ).toEqual(405);
});

test("POST /api/v1/plan-runs/:id/apply is not a public compatibility route", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const legacy = request("POST", "/api/v1/plan-runs/plan_1/apply", {
    cookie,
  });
  expect(
    (
      await handleControlRoute({
        request: legacy.request,
        url: legacy.url,
        store,
        operations,
      })
    )?.status,
  ).toEqual(404);
  expect(operations.calls.createApplyRun).toBeUndefined();
});

test("maybeEnsurePersonalWorkspaceForSession is a no-op without an operations facade", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const { request: req } = request("GET", "/v1/account/session/me", { cookie });
  // No operations -> returns quietly.
  await maybeEnsurePersonalWorkspaceForSession({ request: req, store });
});

// --- Deployments / outputs / rollback (§30 GUI deploy) ---------------------

/**
 * A Deployment ledger row whose `outputsPublic` is the allowlist projection.
 * `outputSnapshotId` points at the raw (un-projected) encrypted Output
 * and MUST be projected out of every session-surface read.
 */
function deploymentRow(
  id: string,
  workspaceId: string,
  capsuleId = "inst_1",
): Record<string, unknown> {
  return {
    id,
    workspaceId,
    capsuleId,
    environment: "production",
    applyRunId: "apply_1",
    sourceSnapshotId: "snap_1",
    stateGeneration: 3,
    outputSnapshotId: "osnap_secret_1",
    outputsPublic: { launch_url: "https://app.example.test" },
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

/**
 * `fakeOperations` does not carry the deployment methods in its base fixture, so
 * we attach recording implementations here. Each records into the same
 * `operations.calls` map the base uses, so the gate-ordering assertions can read
 * which facade method was reached.
 */
function deploymentOperations(
  workspaceId: string,
  overrides: Parameters<typeof fakeOperations>[0] = {},
): ReturnType<typeof fakeOperations> {
  const operations = fakeOperations(overrides);
  const calls = operations.calls;
  operations.listDeployments = async (capsuleId: string) => {
    calls.listDeployments = [capsuleId];
    return {
      deployments: [deploymentRow("dep_1", workspaceId, capsuleId)],
    } as unknown as Awaited<
      ReturnType<ControlPlaneOperations["listDeployments"]>
    >;
  };
  operations.getDeployment = async (id: string) => {
    calls.getDeployment = [id];
    return deploymentRow(id, workspaceId) as unknown as Awaited<
      ReturnType<ControlPlaneOperations["getDeployment"]>
    >;
  };
  operations.createDeploymentRollbackPlan = async (deploymentId: string) => {
    calls.createDeploymentRollbackPlan = [deploymentId];
    return {
      planRun: {
        id: "plan_rollback",
        workspaceId,
        status: "queued",
        operation: "update",
        capsuleId: "inst_1",
        rolledBackFromDeploymentId: deploymentId,
      },
    } as unknown as Awaited<
      ReturnType<ControlPlaneOperations["createDeploymentRollbackPlan"]>
    >;
  };
  return operations;
}

function otherWorkspaceWorkspaces(): NonNullable<
  Parameters<typeof fakeOperations>[0]
>["spaces"] {
  return {
    getWorkspace: async (id) => ({
      id,
      handle: "other",
      displayName: "Other",
      type: "personal" as const,
      ownerUserId: "tsub_other",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }),
  };
}

test("GET /api/v1/installations/:id/deployments lists deployments for an owned Workspace", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = deploymentOperations("space_a");
  const { request: req, url } = request(
    "GET",
    "/api/v1/installations/inst_1/deployments",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    deployments: Array<Record<string, unknown>>;
  };
  expect(body.deployments.length).toEqual(1);
  // The Capsule's Workspace was resolved server-side for the gate.
  expect(operations.calls.getCapsule).toEqual(["inst_1"]);
  expect(operations.calls.listDeployments).toEqual(["inst_1"]);
  // The raw Output pointer is projected out of every row.
  expect(body.deployments[0]!.outputSnapshotId).toBeUndefined();
  expect(body.deployments[0]!.outputsPublic).toEqual({
    launch_url: "https://app.example.test",
  });
});

test("GET /api/v1/capsules/:id/state-versions aliases the final StateVersion list route", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = deploymentOperations("space_a");
  const { request: req, url } = request(
    "GET",
    "/api/v1/capsules/inst_1/state-versions",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    deployments: Array<Record<string, unknown>>;
  };
  expect(body.deployments.length).toEqual(1);
  expect(operations.calls.getCapsule).toEqual(["inst_1"]);
  expect(operations.calls.listDeployments).toEqual(["inst_1"]);
});

test("GET /api/v1/state-versions/:id aliases the final StateVersion read route", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = deploymentOperations("space_a");
  const { request: req, url } = request("GET", "/api/v1/state-versions/dep_1", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    deployment: Record<string, unknown>;
  };
  expect(body.deployment.id).toEqual("dep_1");
  expect(operations.calls.getDeployment).toEqual(["dep_1"]);
});

test("GET /api/v1/installations/:id/deployments rejects a non-member session with 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The Capsule belongs to space_b, owned by a different subject.
  const operations = deploymentOperations("space_b", {
    spaces: otherWorkspaceWorkspaces(),
    installations: {
      getCapsule: async (id) => ({
        id,
        workspaceId: "space_b",
        name: "inst",
        environment: "production",
        sourceId: "src_1",
        installConfigId: "ic_1",
        status: "ready" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
  });
  const { request: req, url } = request(
    "GET",
    "/api/v1/installations/inst_b/deployments",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  // The gate rejects before any deployment listing.
  expect(operations.calls.listDeployments).toBeUndefined();
});

test("GET /api/v1/deployments/:id returns only the public outputs projection", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = deploymentOperations("space_a");
  const { request: req, url } = request("GET", "/api/v1/deployments/dep_1", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  // The Deployment was resolved server-side to learn its Workspace for the gate.
  expect(operations.calls.getDeployment).toEqual(["dep_1"]);
  const body = (await response!.json()) as {
    deployment: Record<string, unknown>;
  };
  // Public outputsPublic is present; the raw Output pointer is gone.
  expect(body.deployment.outputsPublic).toEqual({
    launch_url: "https://app.example.test",
  });
  expect(body.deployment.outputSnapshotId).toBeUndefined();
  // No raw Output handle leaks into the serialized response.
  expect(JSON.stringify(body)).not.toContain("osnap_secret_1");
});

test("GET /api/v1/deployments/:id rejects a deployment in another Workspace with 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The Deployment belongs to space_b, owned by a different subject.
  const operations = deploymentOperations("space_b", {
    spaces: otherWorkspaceWorkspaces(),
  });
  const { request: req, url } = request(
    "GET",
    "/api/v1/deployments/dep_other",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  // The Deployment was resolved (to learn its Workspace) but the gate rejects; no
  // projection is returned, so nothing could leak.
  expect(operations.calls.getDeployment).toEqual(["dep_other"]);
});

test("POST /api/v1/deployments/:id/rollback-plan creates a rollback plan for an owned Workspace", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = deploymentOperations("space_a");
  const { request: req, url } = request(
    "POST",
    "/api/v1/deployments/dep_1/rollback-plan",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  // The Deployment's Workspace was resolved server-side for the gate first.
  expect(operations.calls.getDeployment).toEqual(["dep_1"]);
  expect(operations.calls.createDeploymentRollbackPlan).toEqual(["dep_1"]);
  const body = (await response!.json()) as { run: { id: string } };
  // The response carries the Run that flows through approve -> apply.
  expect(body.run.id).toEqual("plan_rollback");
});

test("POST /api/v1/deployments/:id/rollback-plan rejects a deployment in another Workspace with 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = deploymentOperations("space_b", {
    spaces: otherWorkspaceWorkspaces(),
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/deployments/dep_other/rollback-plan",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  // The gate rejects before any rollback plan is created.
  expect(operations.calls.createDeploymentRollbackPlan).toBeUndefined();
});

test("deployments routes are 401 for anonymous sessions", async () => {
  const store = new InMemoryAccountsStore();
  const operations = deploymentOperations("space_a");
  const paths: Array<[string, string]> = [
    ["GET", "/api/v1/installations/inst_1/deployments"],
    ["GET", "/api/v1/deployments/dep_1"],
    ["POST", "/api/v1/deployments/dep_1/rollback-plan"],
  ];
  for (const [method, path] of paths) {
    const { request: req, url } = request(method, path);
    const response = await handleControlRoute({
      request: req,
      url,
      store,
      operations,
    });
    expect(response?.status, `${method} ${path}`).toEqual(401);
    await response?.body?.cancel();
  }
  // No facade method was reached behind the auth gate.
  expect(operations.calls.getDeployment).toBeUndefined();
  expect(operations.calls.listDeployments).toBeUndefined();
  expect(operations.calls.createDeploymentRollbackPlan).toBeUndefined();
});

test("POST /api/v1/deployments/:id/rollback-plan rejects an unknown leaf and the wrong method", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = deploymentOperations("space_a");
  const bogus = request("POST", "/api/v1/deployments/dep_1/bogus", {
    cookie,
  });
  expect(
    (
      await handleControlRoute({
        request: bogus.request,
        url: bogus.url,
        store,
        operations,
      })
    )?.status,
  ).toEqual(404);
  const wrongMethod = request("DELETE", "/api/v1/deployments/dep_1", {
    cookie,
  });
  expect(
    (
      await handleControlRoute({
        request: wrongMethod.request,
        url: wrongMethod.url,
        store,
        operations,
      })
    )?.status,
  ).toEqual(405);
});

// --- Members (Workspace membership / roles) ------------------------------------

type MemberRow = {
  id: string;
  workspaceId: string;
  accountId: string;
  roles: string[];
  status: "active" | "invited" | "suspended";
  createdAt: string;
  updatedAt: string;
};

/**
 * A `fakeOperations` whose `members` facade is backed by an in-memory roster.
 * `spaceOwner` controls the namespace gate (`requireWorkspaceAccess`): when it
 * equals the session subject the namespace gate passes, so a 403 there isolates
 * the membership ROLE gate. The roster seeds the per-account roles the route
 * reads to decide the role/last-owner gate.
 */
function memberOperations(options: {
  workspaceId: string;
  spaceOwner: string;
  roster: MemberRow[];
}): ControlPlaneOperations & {
  calls: Record<string, unknown[]>;
  roster: MemberRow[];
} {
  const roster = options.roster;
  const base = fakeOperations({
    spaces: {
      getWorkspace: async (id) => ({
        id,
        handle: "team",
        displayName: "Team",
        type: "personal" as const,
        ownerUserId: options.spaceOwner,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
  });
  const members: NonNullable<ControlPlaneOperations["members"]> = {
    listMembers: async (workspaceId) => {
      base.calls.listMembers = [workspaceId];
      return roster.filter((member) => member.workspaceId === workspaceId);
    },
    upsertMember: async (input) => {
      base.calls.upsertMember = [input];
      const now = "2026-02-02T00:00:00Z";
      const existing = roster.find(
        (member) =>
          member.workspaceId === input.workspaceId &&
          member.accountId === input.accountId,
      );
      const next: MemberRow = {
        id: existing?.id ?? `mem_${input.accountId}`,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        roles: [...(input.roles ?? existing?.roles ?? ["member"])],
        status: input.status ?? existing?.status ?? "active",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing) {
        roster[roster.indexOf(existing)] = next;
      } else {
        roster.push(next);
      }
      return next;
    },
  };
  return Object.assign(base, { members, roster });
}

function memberRow(
  accountId: string,
  roles: string[],
  status: "active" | "invited" | "suspended" = "active",
  workspaceId = "space_a",
): MemberRow {
  return {
    id: `mem_${accountId}`,
    workspaceId,
    accountId,
    roles,
    status,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

test("GET /api/v1/spaces/:id/members lists members for an active member", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The session subject is a plain MEMBER (not owner/admin); list is still
  // visible to any active member.
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_owner", ["owner"]),
      memberRow("tsub_ctrl", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/members",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { members: MemberRow[] };
  expect(body.members.length).toEqual(2);
  // The workspaceId was resolved server-side for the membership read.
  expect(operations.calls.listMembers).toEqual(["space_a"]);
});

test("POST /api/v1/spaces/:id/members lets an owner add a member", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [memberRow("tsub_ctrl", ["owner"])],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_new", role: "member" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as { member: MemberRow };
  expect(body.member.accountId).toEqual("tsub_new");
  expect(body.member.roles).toEqual(["member"]);
  expect(body.member.status).toEqual("active");
  // The workspaceId in the upsert is the server-resolved path value, never client body.
  const upsertArg = (
    operations.calls.upsertMember as [Record<string, unknown>]
  )[0];
  expect(upsertArg.workspaceId).toEqual("space_a");
  expect(upsertArg.accountId).toEqual("tsub_new");
});

test("POST /api/v1/spaces/:id/members resolves a verified email to an account", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const now = Date.now();
  store.saveAccount({
    subject: "tsub_member_email",
    email: "Member@Example.Test",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [memberRow("tsub_ctrl", ["owner"])],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { email: " member@example.test ", role: "viewer" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as { member: MemberRow };
  expect(body.member.accountId).toEqual("tsub_member_email");
  expect(body.member.roles).toEqual(["viewer"]);
  const upsertArg = (
    operations.calls.upsertMember as [Record<string, unknown>]
  )[0];
  expect(upsertArg.accountId).toEqual("tsub_member_email");
});

test("POST /api/v1/spaces/:id/members rejects an email that is not verified", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const now = Date.now();
  store.saveAccount({
    subject: "tsub_unverified",
    email: "pending@example.test",
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [memberRow("tsub_ctrl", ["owner"])],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { email: "pending@example.test", role: "member" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(404);
  expect(operations.calls.upsertMember).toBeUndefined();
});

test("POST /api/v1/spaces/:id/members lets an admin add a member", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_owner", ["owner"]),
      memberRow("tsub_ctrl", ["admin"]),
    ],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_new", role: "viewer" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
});

test("POST /api/v1/spaces/:id/members forbids a non-owner/admin member with 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // Namespace gate passes (the session subject owns the namespace Workspace), so a
  // 403 here isolates the membership ROLE gate: a plain member cannot add.
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_owner", ["owner"]),
      memberRow("tsub_ctrl", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_new", role: "member" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  // No member was upserted behind the role gate.
  expect(operations.calls.upsertMember).toBeUndefined();
});

test("POST /api/v1/spaces/:id/members forbids an admin granting owner with 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_owner", ["owner"]),
      memberRow("tsub_ctrl", ["admin"]),
    ],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_new", role: "owner" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.upsertMember).toBeUndefined();
});

test("members routes reject a session in another Workspace with 403 (namespace gate)", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The namespace Workspace is owned by a DIFFERENT subject; the namespace gate
  // (requireWorkspaceAccess) rejects before any membership read.
  const operations = memberOperations({
    workspaceId: "space_b",
    spaceOwner: "tsub_other",
    roster: [memberRow("tsub_other", ["owner"], "active", "space_b")],
  });
  for (const [method, body] of [
    ["GET", undefined],
    ["POST", { accountId: "tsub_x", role: "member" }],
  ] as const) {
    const { request: req, url } = request(
      method,
      "/api/v1/spaces/space_b/members",
      { cookie, ...(body ? { body } : {}) },
    );
    const response = await handleControlRoute({
      request: req,
      url,
      store,
      operations,
    });
    expect(response?.status, method).toEqual(403);
  }
  // The membership facade was never reached behind the namespace gate.
  expect(operations.calls.listMembers).toBeUndefined();
  expect(operations.calls.upsertMember).toBeUndefined();
});

test("members routes are 401 for an anonymous session", async () => {
  const store = new InMemoryAccountsStore();
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [memberRow("tsub_ctrl", ["owner"])],
  });
  const paths: Array<[string, string]> = [
    ["GET", "/api/v1/spaces/space_a/members"],
    ["POST", "/api/v1/spaces/space_a/members"],
    ["PATCH", "/api/v1/spaces/space_a/members/tsub_x"],
    ["DELETE", "/api/v1/spaces/space_a/members/tsub_x"],
  ];
  for (const [method, path] of paths) {
    const { request: req, url } = request(method, path);
    const response = await handleControlRoute({
      request: req,
      url,
      store,
      operations,
    });
    expect(response?.status, `${method} ${path}`).toEqual(401);
    await response?.body?.cancel();
  }
  expect(operations.calls.listMembers).toBeUndefined();
  expect(operations.calls.upsertMember).toBeUndefined();
});

test("PATCH /api/v1/spaces/:id/members/:subject lets an owner change a role", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_ctrl", ["owner"]),
      memberRow("tsub_member", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "PATCH",
    "/api/v1/spaces/space_a/members/tsub_member",
    { cookie, body: { roles: ["admin"] } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { member: MemberRow };
  expect(body.member.roles).toEqual(["admin"]);
  const upsertArg = (
    operations.calls.upsertMember as [Record<string, unknown>]
  )[0];
  expect(upsertArg.accountId).toEqual("tsub_member");
});

test("PATCH /api/v1/spaces/:id/members/:subject forbids an admin (owner-only) with 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_owner", ["owner"]),
      memberRow("tsub_ctrl", ["admin"]),
      memberRow("tsub_member", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "PATCH",
    "/api/v1/spaces/space_a/members/tsub_member",
    { cookie, body: { roles: ["admin"] } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.upsertMember).toBeUndefined();
});

test("PATCH /api/v1/spaces/:id/members/:subject refuses to demote the last owner", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The owner tries to demote themselves while they are the SOLE owner.
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_ctrl", ["owner"]),
      memberRow("tsub_member", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "PATCH",
    "/api/v1/spaces/space_a/members/tsub_ctrl",
    { cookie, body: { roles: ["member"] } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  // The last-owner guard blocks before any upsert.
  expect(operations.calls.upsertMember).toBeUndefined();
});

test("PATCH /api/v1/spaces/:id/members/:subject can demote an owner when another owner remains", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_ctrl", ["owner"]),
      memberRow("tsub_owner2", ["owner"]),
    ],
  });
  const { request: req, url } = request(
    "PATCH",
    "/api/v1/spaces/space_a/members/tsub_owner2",
    { cookie, body: { roles: ["admin"] } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { member: MemberRow };
  expect(body.member.roles).toEqual(["admin"]);
});

test("DELETE /api/v1/spaces/:id/members/:subject lets an owner soft-remove a member", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_ctrl", ["owner"]),
      memberRow("tsub_member", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "DELETE",
    "/api/v1/spaces/space_a/members/tsub_member",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { member: MemberRow };
  // Soft-remove: the membership is suspended (the store has no hard delete).
  expect(body.member.status).toEqual("suspended");
  const upsertArg = (
    operations.calls.upsertMember as [Record<string, unknown>]
  )[0];
  expect(upsertArg.status).toEqual("suspended");
  expect(upsertArg.accountId).toEqual("tsub_member");
});

test("DELETE /api/v1/spaces/:id/members/:subject forbids a non-owner with 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_owner", ["owner"]),
      memberRow("tsub_ctrl", ["admin"]),
      memberRow("tsub_member", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "DELETE",
    "/api/v1/spaces/space_a/members/tsub_member",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.upsertMember).toBeUndefined();
});

test("DELETE /api/v1/spaces/:id/members/:subject refuses to remove the last owner", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_ctrl", ["owner"]),
      memberRow("tsub_member", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "DELETE",
    "/api/v1/spaces/space_a/members/tsub_ctrl",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.upsertMember).toBeUndefined();
});

test("members routes 503 when no membership facade is wired", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // A facade WITHOUT the optional `members` field (the namespace gate still
  // passes because the session subject owns the namespace Workspace).
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/members",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(503);
});

// --- ADD-path gate parity (privilege escalation / orphaning via POST) -------

test("POST /api/v1/spaces/:id/members forbids an admin from demoting an existing owner", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The caller is an ADMIN; the target is an existing active OWNER. A POST that
  // overwrites the owner's role to `member` must be rejected (owner-only), the
  // same way the PATCH path restricts it.
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_owner", ["owner"]),
      memberRow("tsub_other_owner", ["owner"]),
      memberRow("tsub_ctrl", ["admin"]),
    ],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_owner", role: "member" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  // No demotion was persisted behind the owner-only gate.
  expect(operations.calls.upsertMember).toBeUndefined();
  expect(
    operations.roster.find((m) => m.accountId === "tsub_owner")?.roles,
  ).toEqual(["owner"]);
});

test("POST /api/v1/spaces/:id/members refuses to strip the last owner", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The caller is the SOLE owner and POSTs their own subject with a lower role.
  // The last-owner guard must block this on the ADD path too, otherwise the
  // Workspace is orphaned.
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_ctrl", ["owner"]),
      memberRow("tsub_member", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_ctrl", role: "member" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.upsertMember).toBeUndefined();
  expect(
    operations.roster.find((m) => m.accountId === "tsub_ctrl")?.roles,
  ).toEqual(["owner"]);
});

test("POST /api/v1/spaces/:id/members lets an owner re-add a co-owner with a lower role when another owner remains", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_ctrl", ["owner"]),
      memberRow("tsub_owner2", ["owner"]),
    ],
  });
  // Owner caller demotes a co-owner via POST; another owner remains, so the
  // last-owner guard does not fire and the owner-only gate is satisfied.
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_owner2", role: "admin" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as { member: MemberRow };
  expect(body.member.roles).toEqual(["admin"]);
});

// --- Namespace-owner bootstrap (empty ledger) ------------------------------

test("namespace owner can bootstrap the first member when the ledger is empty", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // No membership rows exist yet (the spaces domain seeds none). The session
  // subject IS the namespace owner (`spaceOwner`), so the implicit owner row
  // lets them add the first real member.
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_first", role: "member" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as { member: MemberRow };
  expect(body.member.accountId).toEqual("tsub_first");
  expect(body.member.roles).toEqual(["member"]);
});

test("namespace owner sees the implicit owner row when the ledger is empty", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [],
  });
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/members",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { members: MemberRow[] };
  const owner = body.members.find((m) => m.accountId === "tsub_ctrl");
  expect(owner?.roles).toEqual(["owner"]);
  expect(owner?.status).toEqual("active");
});

test("a non-owner namespace member cannot bootstrap members against an empty ledger", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The session subject is NOT the namespace owner; the namespace gate passes
  // only because the accounts-ledger owner matches. With an empty membership
  // ledger and no implicit row for THIS subject, the mutation gate forbids them.
  seedLedgerWorkspace(store, {
    subject: "tsub_ctrl",
    accountId: "acct_a",
    workspaceId: "space_a",
  });
  const operations = memberOperations({
    workspaceId: "space_a",
    spaceOwner: "tsub_namespace_owner",
    roster: [],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_first", role: "member" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.upsertMember).toBeUndefined();
});
