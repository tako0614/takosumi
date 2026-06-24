import { expect, test } from "bun:test";

import {
  type ControlPlaneOperations,
  handleControlRoute,
  isControlRoutePath,
} from "../../../../accounts/service/src/control-routes.ts";
import {
  maybeEnsurePersonalSpaceForSession,
  personalSpaceHandle,
} from "../../../../accounts/service/src/control-personal-space.ts";
import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

// --- Test harness ----------------------------------------------------------

const ORIGIN = "https://app.takosumi.test";

async function publicProviderConnectionIdForTest(
  providerEnvId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `takosumi-provider-connection:v1:${providerEnvId}`,
    ),
  );
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `pcn_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "").slice(0, 32)}`;
}

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

function seedLedgerSpace(
  store: InMemoryAccountsStore,
  input: { subject: string; accountId: string; spaceId: string },
): void {
  const now = Date.now();
  store.saveLedgerAccount({
    accountId: input.accountId,
    legalOwnerSubject: input.subject,
    createdAt: now,
    updatedAt: now,
  });
  store.saveSpace({
    spaceId: input.spaceId,
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
  const installation = (id: string, spaceId: string) => ({
    id,
    spaceId,
    name: "app",
    slug: "app",
    sourceId: "src_x",
    installType: "opentofu_module" as const,
    installConfigId: "cfg_x",
    environment: "prod",
    currentOutputSnapshotId: "osnap_secret_1",
    currentStateGeneration: 0,
    status: "ready" as const,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  const base: ControlPlaneOperations = {
    spaces: {
      listSpaces: async () => {
        record("listSpaces");
        return [space("space_a")];
      },
      listSpacesByOwner: async (ownerUserId) => {
        record("listSpacesByOwner", ownerUserId);
        // The fixture Space is owned by `tsub_ctrl`; other subjects own none
        // directly (they reach Spaces only via the ledger legal-owner branch).
        return ownerUserId === "tsub_ctrl" ? [space("space_a")] : [];
      },
      getSpace: async (id) => {
        record("getSpace", id);
        return space(id);
      },
      createSpace: async (req) => {
        record("createSpace", req);
        return { ...space("space_new"), handle: req.handle, type: req.type };
      },
      updateSpace: async (id, patch) => {
        record("updateSpace", id, patch);
        return { ...space(id), ...patch, updatedAt: "2026-01-02T00:00:00Z" };
      },
    },
    installations: {
      getInstallation: async (id) => {
        record("getInstallation", id);
        return installation(id, "space_a");
      },
      listInstallations: async (spaceId) => {
        record("listInstallations", spaceId);
        return [installation("inst_1", spaceId)];
      },
      listInstallationsPage: async (spaceId, params) => {
        record("listInstallationsPage", spaceId, params);
        return { items: [installation("inst_1", spaceId)] };
      },
      createInstallation: async (req) => {
        record("createInstallation", req);
        return installation("inst_new", req.spaceId);
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
      listInstallConfigs: async (spaceId) => {
        record("listInstallConfigs", spaceId);
        return [];
      },
      patchInstallationStatus: async (id, status) => {
        record("patchInstallationStatus", id, status);
        return { ...installation(id, "space_a"), status };
      },
      putInstallationProviderEnvBindingSet: async (profile) => {
        record("putInstallationProviderEnvBindingSet", profile);
        return profile;
      },
      getInstallationProviderEnvBindingSetByInstallation: async (
        installationId,
        environment,
      ) => {
        record(
          "getInstallationProviderEnvBindingSetByInstallation",
          installationId,
          environment,
        );
        return {
          id: "dpf_1",
          spaceId: "space_a",
          installationId,
          environment,
          bindings: [
            { provider: "cloudflare", alias: "main", envId: "penv_cf_gateway" },
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
          spaceId: req.spaceId,
          producerInstallationId: req.producerInstallationId,
          consumerInstallationId: req.consumerInstallationId,
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
          spaceId: "space_a",
          producerInstallationId: "inst_1",
          consumerInstallationId: "inst_2",
          mode: "variable_injection",
          outputs: {},
          visibility: "space",
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      listForInstallation: async (installationId) => {
        record("listForInstallation", installationId);
        return {
          asProducer: [
            {
              id: "dep_downstream",
              spaceId: "space_a",
              producerInstallationId: installationId,
              consumerInstallationId: "inst_consumer",
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
    listDependenciesBySpace: async (spaceId) => {
      record("listDependenciesBySpace", spaceId);
      return [
        {
          id: "dep_1",
          spaceId,
          producerInstallationId: "inst_1",
          consumerInstallationId: "inst_2",
          mode: "variable_injection",
          outputs: { db_url: { from: "url", to: "db_url", required: true } },
          visibility: "space",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ];
    },
    runGroups: {
      createSpaceUpdate: async (spaceId) => {
        record("createSpaceUpdate", spaceId);
        return { runGroup: { id: "rg_1", spaceId }, runs: [] };
      },
      createSpaceDriftCheck: async (spaceId, options) => {
        record("createSpaceDriftCheck", spaceId, options);
        return {
          runGroup: { id: "rg_drift", spaceId, type: "space_drift_check" },
          runs: [],
        };
      },
      getRunGroup: async (id) => {
        record("getRunGroup", id);
        return { runGroup: { id, spaceId: "space_a" }, runs: [] };
      },
      approveRunGroup: async (id) => {
        record("approveRunGroup", id);
        return { runGroup: { id, spaceId: "space_a" }, runs: [] };
      },
    },
    activity: {
      list: async (spaceId, limit) => {
        record("activityList", spaceId, limit);
        return [];
      },
    },
    backups: {
      createBackup: async (input) => {
        record("createBackup", input);
        return {
          id: "bkp_1",
          spaceId: input.spaceId,
          objectKey: `spaces/${input.spaceId}/backups/bkp_1/control.json.zst.enc`,
          digest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sizeBytes: 128,
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      listBackups: async (spaceId) => {
        record("listBackups", spaceId);
        return {
          backups: [
            {
              id: "bkp_1",
              spaceId,
              objectKey: `spaces/${spaceId}/backups/bkp_1/control.json.zst.enc`,
              digest:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              sizeBytes: 128,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        };
      },
    },
    createRestoreRun: async (spaceId, backupId, request, context) => {
      record("createRestoreRun", spaceId, backupId, request, context);
      return {
        id: "restore_1",
        spaceId,
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
        spaceId: input.spaceId,
        url: `https://uploads.takosumi.com/${input.spaceId}`,
        ref: "upload",
        resolvedCommit:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        path: input.path ?? ".",
        archiveObjectKey: `spaces/${input.spaceId}/uploads/snap_upload/source.tar.zst`,
        archiveDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        archiveSizeBytes: input.bytes.byteLength,
        fetchedByRunId: "upload",
        fetchedAt: "2026-01-01T00:00:00Z",
      };
    },
    getSourceSnapshot: async (id) => {
      record("getSourceSnapshot", id);
      return {
        id,
        origin: "upload",
        spaceId: "space_a",
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
          spaceId: req.spaceId,
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
          spaceId: req.spaceId,
          installationId: "inst_upload",
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
    getSpaceBilling: async (spaceId) => {
      record("getSpaceBilling", spaceId);
      return {
        billing: {
          settings: { mode: "showback", provider: "manual" },
          balance: {
            spaceId,
            availableCredits: 120,
            reservedCredits: 8,
            monthlyIncludedCredits: 100,
            purchasedCredits: 20,
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
      };
    },
    listSpaceUsage: async (spaceId) => {
      record("listSpaceUsage", spaceId);
      return {
        usageEvents: [
          {
            id: "use_1",
            spaceId,
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
    listSpaceCreditReservations: async (spaceId) => {
      record("listSpaceCreditReservations", spaceId);
      return {
        creditReservations: [
          {
            id: "cres_1",
            spaceId,
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
    topUpSpaceCredits: async (spaceId, input) => {
      record("topUpSpaceCredits", spaceId, input);
      return {
        balance: {
          spaceId,
          availableCredits: input.credits,
          reservedCredits: 0,
          monthlyIncludedCredits: 0,
          purchasedCredits: input.credits,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      };
    },
    changeSpaceSubscription: async (spaceId, input) => {
      record("changeSpaceSubscription", spaceId, input);
      return { billing: { settings: input.billingSettings } };
    },
    reconcileStripeSpaceSubscription: async (spaceId, input) => {
      record("reconcileStripeSpaceSubscription", spaceId, input);
      return {};
    },
    connections: {
      listProviderEnvs: async () => {
        record("listProviderEnvs");
        return [];
      },
      getGatewayCoverageStatus: async () => {
        record("getGatewayCoverageStatus");
        return { available: false, resources: [] };
      },
    },
    outputShares: {
      createShare: async (req) => {
        record("createOutputShare", req);
        return {
          id: "oshare_1",
          fromSpaceId: req.fromSpaceId,
          toSpaceId: req.toSpaceId,
          producerInstallationId: req.producerInstallationId,
          outputs: req.outputs.map((output) => ({
            name: output.name,
            ...(output.alias ? { alias: output.alias } : {}),
            sensitive: output.sensitive === true,
          })),
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      listForSpace: async (spaceId) => {
        record("listOutputShares", spaceId);
        return [
          {
            id: "oshare_1",
            fromSpaceId: spaceId,
            toSpaceId: "space_b",
            producerInstallationId: "inst_1",
            outputs: [{ name: "domain", sensitive: false }],
            status: "active",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ];
      },
      listForSpacePage: async (spaceId) => {
        record("listOutputShares", spaceId);
        return {
          items: [
            {
              id: "oshare_1",
              fromSpaceId: spaceId,
              toSpaceId: "space_b",
              producerInstallationId: "inst_1",
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
          fromSpaceId: "space_a",
          toSpaceId: "space_b",
          producerInstallationId: "inst_1",
          outputs: [{ name: "domain", sensitive: false }],
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      approveShare: async (id) => {
        record("approveOutputShare", id);
        return {
          id,
          fromSpaceId: "space_a",
          toSpaceId: "space_b",
          producerInstallationId: "inst_1",
          outputs: [{ name: "domain", sensitive: false }],
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      revokeShare: async (id) => {
        record("revokeOutputShare", id);
        return {
          id,
          fromSpaceId: "space_a",
          toSpaceId: "space_b",
          producerInstallationId: "inst_1",
          outputs: [{ name: "domain", sensitive: false }],
          status: "revoked",
          createdAt: "2026-01-01T00:00:00Z",
          revokedAt: "2026-01-01T00:01:00Z",
        };
      },
    },
    listConnections: async (spaceId) => {
      record("listConnections", spaceId);
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
        spaceId: "space_a",
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
          spaceId: request.spaceId ?? "space_a",
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
    createInstallationPlan: async (installationId) => {
      record("createInstallationPlan", installationId);
      return { planRun: { id: "plan_1" } } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["createInstallationPlan"]>
      >;
    },
    createInstallationDestroyPlan: async (installationId) => {
      record("createInstallationDestroyPlan", installationId);
      return { planRun: { id: "plan_destroy" } } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["createInstallationDestroyPlan"]>
      >;
    },
    createInstallationDriftCheck: async (installationId) => {
      record("createInstallationDriftCheck", installationId);
      return { planRun: { id: "plan_drift" } } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["createInstallationDriftCheck"]>
      >;
    },
    getRun: async (id) => {
      record("getRun", id);
      return {
        id,
        spaceId: "space_a",
        status: "succeeded",
      } as unknown as Awaited<ReturnType<ControlPlaneOperations["getRun"]>>;
    },
    approveRun: async (id, input) => {
      record("approveRun", id, input);
      return { id, spaceId: "space_a", status: "queued" } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["approveRun"]>
      >;
    },
    cancelRun: async (id) => {
      record("cancelRun", id);
      return {
        id,
        spaceId: "space_a",
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
          spaceId: "space_a",
          installationId: "inst_upload",
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
          spaceId: "space_a",
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
          spaceId: "space_a",
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
          spaceId: "space_a",
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
    listSources: async (spaceId) => {
      record("listSources", spaceId);
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
            spaceId: "space_a",
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
            ownershipOptions: ["own_key"],
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
  init: { cookie?: string; body?: unknown } = {},
): { request: Request; url: URL } {
  const url = new URL(`${ORIGIN}${path}`);
  const headers: Record<string, string> = {};
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
  // load every tenant's Space via the all-spaces `listSpaces` path.
  expect(operations.calls.listSpacesByOwner).toBeDefined();
  expect(operations.calls.listSpaces).toBeUndefined();
  // GET /spaces also synchronously ensures the first-login personal Space so
  // an OAuth redirect cannot land the dashboard in an empty Workspace race.
  const createCall = operations.calls.createSpace?.[0] as
    | { ownerUserId?: string; type?: string }
    | undefined;
  expect(createCall?.ownerUserId).toEqual("tsub_ctrl");
  expect(createCall?.type).toEqual("personal");
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
  expect(operations.calls.listSpacesByOwner).toBeDefined();
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
  expect(operations.calls.listInstallationsPage?.[0]).toEqual("space_a");
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
  expect(operations.calls.listSpaces).toBeUndefined();
});

test("GET /api/v1/spaces/:id a session cannot access is 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store, { subject: "tsub_outsider" });
  // The Space is owned by a DIFFERENT subject; the outsider session is denied.
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
    ["GET", "/api/v1/spaces/space_a/backups"],
    ["POST", "/api/v1/spaces/space_a/backups"],
    ["POST", "/api/v1/spaces/space_a/backups/bkp_1/restores"],
    ["GET", "/api/v1/spaces/space_a/billing"],
    ["GET", "/api/v1/spaces/space_a/usage"],
    ["GET", "/api/v1/spaces/space_a/credit-reservations"],
    ["GET", "/api/v1/billing/plans"],
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
  expect(operations.calls.listSpacesByOwner).toBeDefined();
  expect(operations.calls.listSpaces).toBeUndefined();
});

test("POST /api/v1/spaces/:id/uploads records an upload snapshot for an owned Space", async () => {
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
    { spaceId: "space_a", bytes: [1, 2, 3], path: "deploy" },
  ]);
});

test("POST /api/v1/deploy deploys an uploaded snapshot through the public facade", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    connections: {
      listProviderEnvs: async () => [
        {
          id: "penv_cf",
          spaceId: "space_a",
          providerSource: "registry.opentofu.org/cloudflare/cloudflare",
          displayName: "Cloudflare",
          materialization: "secret",
          status: "ready",
          requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      getGatewayCoverageStatus: async () => ({
        available: false,
        resources: [],
      }),
    },
  });
  const { request: req, url } = request("POST", "/api/v1/deploy", {
    cookie,
    body: {
      spaceId: "space_a",
      name: "hello",
      environment: "preview",
      snapshotId: "snap_upload",
      vars: { greeting: "hi" },
      outputAllowlist: {
        url: { from: "url", type: "url", required: true },
        worker_name: { from: "worker_name", type: "string" },
      },
      providerConnections: [
        {
          provider: "cloudflare",
          alias: "main",
          connectionId: await publicProviderConnectionIdForTest("penv_cf"),
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
      spaceId: "space_a",
      name: "hello",
      environment: "preview",
      snapshotId: "snap_upload",
      vars: { greeting: "hi" },
      outputAllowlist: {
        url: { from: "url", type: "url", required: true },
        worker_name: { from: "worker_name", type: "string" },
      },
      providerEnvBindings: [
        {
          provider: "cloudflare",
          alias: "main",
          envId: "penv_cf",
        },
      ],
      autoApprove: true,
    },
  ]);
  const projection = await store.findAppInstallation("inst_upload");
  expect(projection?.status).toEqual("installing");
  expect(projection?.spaceId).toEqual("space_a");
  expect(projection?.createdBySubject).toEqual("tsub_ctrl");
  expect(projection?.sourceGitUrl).toEqual("upload://space_a");
  expect(projection?.sourceRef).toEqual("upload");
  expect(projection?.sourceCommit).toEqual(
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  const events = await store.listInstallationEvents("inst_upload");
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
      spaceId: "space_a",
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
    sharedCellRuntime: async ({ installationId, now }) => ({
      runtimeBindingId: `rtb_${installationId}_shared_cell`,
      installationId,
      mode: "shared-cell",
      targetType: "shared-cell",
      targetId: `shared-cell://tokyo-cell-01/namespaces/${installationId}`,
      createdAt: now,
      updatedAt: now,
    }),
  });

  expect(response?.status).toEqual(200);
  expect(operations.calls.deployUpload).toEqual([
    {
      spaceId: "space_a",
      name: "hello",
      snapshotId: "snap_upload",
    },
  ]);
  const projection = await store.findAppInstallation("inst_upload");
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
        spaceId: "space_a",
        installationId: "inst_upload",
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
      spaceId: "space_a",
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
  expect((await store.findAppInstallation("inst_upload"))?.status).toEqual(
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
  const projection = await store.findAppInstallation("inst_upload");
  expect(projection?.status).toEqual("ready");
  const events = await store.listInstallationEvents("inst_upload");
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
      spaceId: "space_a",
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
  // (B) An org Space whose deploy-control owner is someone else, but whose
  // accounts ledger account is LEGALLY OWNED by the session subject -> visible.
  seedLedgerSpace(store, {
    subject,
    accountId: "acct_org",
    spaceId: "space_org",
  });
  // A foreign Space: different ledger account, legally owned by another subject
  // -> must be absent. (Also never directly owned by the session subject.)
  seedLedgerSpace(store, {
    subject: "tsub_foreign",
    accountId: "acct_foreign",
    spaceId: "space_foreign",
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
  let listSpacesByOwnerCalled = false;
  const operations = fakeOperations({
    spaces: {
      // (A) Direct owner: only the personal Space the subject owns directly.
      listSpacesByOwner: async () => {
        listSpacesByOwnerCalled = true;
        return [spaceRecord("space_a", subject)];
      },
      // Per-id fetch is bounded to the subject's own ledger spaces; the org
      // Space is owned (deploy-control) by another subject but is reachable via
      // the legal-owner branch. A foreign-space fetch would still be excluded
      // because the route only fetches ledger spaces owned by the subject.
      getSpace: async (id) => {
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
  expect(operations.calls.listSpaces).toBeUndefined();
  expect(listSpacesByOwnerCalled).toEqual(true);
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
  expect(operations.calls.getSpaceBilling).toEqual(["space_a"]);
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
  expect(operations.calls.listSpaceUsage).toEqual(["space_a"]);
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
  expect(operations.calls.listSpaceCreditReservations).toEqual(["space_a"]);
});

test("GET /api/v1/spaces/:id/backups lists Space backups", async () => {
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

test("POST /api/v1/spaces/:id/backups creates a Space backup", async () => {
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
  const body = (await response!.json()) as { backup: { spaceId: string } };
  expect(body.backup.spaceId).toEqual("space_a");
  expect(operations.calls.createBackup).toEqual([{ spaceId: "space_a" }]);
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
        installationId: "inst_1",
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
      installationId: "inst_1",
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
  expect(operations.calls.topUpSpaceCredits).toBeUndefined();
  expect(operations.calls.changeSpaceSubscription).toBeUndefined();
});

test("GET /api/v1/billing/plans serves the public operator catalog", async () => {
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
    billingPlans: [
      {
        id: "starter",
        kind: "subscription",
        stripePriceId: "price_starter",
        credits: 500,
        name: { ja: "スターター", en: "Starter" },
        priceDisplay: { ja: "¥1,000 / 月", en: "$8 / mo" },
      },
    ],
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    plans: Array<Record<string, unknown>>;
  };
  expect(body.plans).toHaveLength(1);
  expect(body.plans[0]!.id).toEqual("starter");
  expect(body.plans[0]!.credits).toEqual(500);
  // The public projection must NOT leak the Stripe price id.
  expect(body.plans[0]!.stripePriceId).toBeUndefined();
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
      listSpaces: async () => [visible, hidden],
      getSpace: async (id) => (id === "space_b" ? hidden : visible),
      createSpace: async (req) => ({
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

test("PATCH /api/v1/spaces/:id updates display name and policy after Space access", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("PATCH", "/api/v1/spaces/space_a", {
    cookie,
    body: {
      displayName: "Shota Lab",
      policy: {
        allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
        quota: { "resources.total": 10 },
      },
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
  expect(operations.calls.updateSpace).toEqual([
    "space_a",
    {
      displayName: "Shota Lab",
      policy: {
        allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
        quota: { "resources.total": 10 },
      },
    },
  ]);
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
  expect(operations.calls.updateSpace).toBeUndefined();
});

test("space-scoped control route rejects a non-member session before dispatch", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      getSpace: async (id) => ({
        id,
        handle: "other",
        displayName: "Other",
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createSpace: async (req) => ({
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
  expect(operations.calls.listInstallations).toBeUndefined();
  expect(operations.calls.listInstallationsPage).toBeUndefined();
});

test("PATCH /api/v1/spaces/:id rejects a non-member session before dispatch", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      getSpace: async (id) => ({
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
  expect(operations.calls.updateSpace).toBeUndefined();
});

test("installation-scoped control route rejects when its Space is inaccessible", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      getSpace: async (id) => ({
        id,
        handle: "other",
        displayName: "Other",
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createSpace: async (req) => ({
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
      getInstallation: async (id) => ({
        id,
        spaceId: "space_b",
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
      listInstallations: async () => [],
      listInstallationsPage: async () => ({ items: [] }),
      createInstallation: async () => {
        throw new Error("unexpected");
      },
      listInstallConfigs: async () => [],
      putInstallationProviderEnvBindingSet: async (profile) => profile,
      getInstallationProviderEnvBindingSetByInstallation: async () => undefined,
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
  expect(operations.calls.createInstallationPlan).toBeUndefined();
});

test("POST /api/v1/spaces/:id/installations rejects a Source from another inaccessible Space", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      getSpace: async (id) => ({
        id,
        handle: id === "space_a" ? "mine" : "other",
        displayName: id === "space_a" ? "Mine" : "Other",
        type: "personal" as const,
        ownerUserId: id === "space_a" ? "tsub_ctrl" : "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createSpace: async (req) => ({
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
        spaceId: "space_b",
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
  expect(operations.calls.createInstallation).toBeUndefined();
});

test("POST /api/v1/sources rejects an authConnectionId from another inaccessible Space", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      getSpace: async (id) => ({
        id,
        handle: id === "space_a" ? "mine" : "other",
        displayName: id === "space_a" ? "Mine" : "Other",
        type: "personal" as const,
        ownerUserId: id === "space_a" ? "tsub_ctrl" : "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createSpace: async (req) => ({
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
      spaceId: "space_b",
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
      spaceId: "space_a",
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

test("POST /api/v1/output-shares rejects a producer from another inaccessible Space", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      getSpace: async (id) => ({
        id,
        handle: id === "space_a" ? "mine" : "other",
        displayName: id === "space_a" ? "Mine" : "Other",
        type: "personal" as const,
        ownerUserId: id === "space_a" ? "tsub_ctrl" : "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createSpace: async (req) => ({
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
      getInstallation: async (id) => ({
        id,
        spaceId: "space_b",
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
      listInstallations: async () => [],
      listInstallationsPage: async () => ({ items: [] }),
      createInstallation: async () => {
        throw new Error("unexpected");
      },
      listInstallConfigs: async () => [],
      putInstallationProviderEnvBindingSet: async (profile) => profile,
      getInstallationProviderEnvBindingSetByInstallation: async () => undefined,
    },
  });
  const { request: req, url } = request("POST", "/api/v1/output-shares", {
    cookie,
    body: {
      fromSpaceId: "space_a",
      toSpaceId: "space_b",
      producerInstallationId: "inst_foreign",
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

test("GET /api/v1/provider-connections rejects an inaccessible Space before dispatch", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      getSpace: async (id) => ({
        id,
        handle: "other",
        displayName: "Other",
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createSpace: async (req) => ({
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
  expect(operations.calls.listProviderEnvs).toBeUndefined();
});

test("GET /api/v1/provider-connections returns ownership projection and never echoes secrets", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The session surface exposes provider connection ownership, not resolver
  // materialization internals or raw secret material.
  const operations = fakeOperations({
    connections: {
      listProviderEnvs: async () => [
        {
          id: "penv_global_secret",
          providerSource: "registry.opentofu.org/cloudflare/cloudflare",
          displayName: "Global secret that must stay internal",
          materialization: "secret",
          status: "ready",
          requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
          secretRef: "conn_operator_secret",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
        {
          id: "penv_space_secret",
          spaceId: "space_a",
          providerSource: "registry.opentofu.org/cloudflare/cloudflare",
          displayName: "Space secret",
          materialization: "secret",
          status: "ready",
          requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
          secretRef: "conn_space_secret",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
        {
          id: "penv_operator_backed",
          spaceId: "space_a",
          providerSource: "registry.opentofu.org/cloudflare/cloudflare",
          displayName: "Takosumi provided Cloudflare",
          materialization: "secret",
          status: "ready",
          requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
          secretRef: "conn_operator_secret",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
      ],
    },
    getConnection: async (connectionId) => {
      if (connectionId === "conn_operator_secret") {
        return {
          id: connectionId,
          provider: "cloudflare",
          kind: "cloudflare_api_token",
          authMethod: "static_secret",
          scope: "operator",
          status: "verified",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        } as unknown as Awaited<
          ReturnType<ControlPlaneOperations["getConnection"]>
        >;
      }
      return fakeOperations().getConnection(connectionId);
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
  expect(raw.includes("conn_operator_secret")).toEqual(false);
  expect(raw.includes("conn_space_secret")).toEqual(false);
  expect(raw.includes("penv_global_secret")).toEqual(false);
  expect(raw.includes("penv_space_secret")).toEqual(false);
  expect(raw.includes("secretRef")).toEqual(false);
  expect(raw.includes("secretValue")).toEqual(false);
  expect(raw.includes("gatewayProfileId")).toEqual(false);
  expect(raw.includes("materialization")).toEqual(false);
  const body = JSON.parse(raw) as {
    providerConnections: readonly Record<string, unknown>[];
  };
  expect(body.providerConnections.length).toEqual(2);
  expect(Object.keys(body.providerConnections[0]!).sort()).toEqual([
    "createdAt",
    "displayName",
    "id",
    "ownership",
    "providerSource",
    "requiredEnvNames",
    "spaceId",
    "status",
    "updatedAt",
  ]);
  expect(body.providerConnections.map((item) => item.ownership)).toEqual([
    "own_key",
    "own_key",
  ]);
  expect(String(body.providerConnections[0]?.id).startsWith("pcn_")).toEqual(
    true,
  );
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

test("accounts-ledger Space owner can access a Space even when ownerUserId is not the session subject", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie, subject } = seedSession(store);
  seedLedgerSpace(store, {
    subject,
    accountId: "acct_ctrl",
    spaceId: "space_ledger",
  });
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      getSpace: async (id) => ({
        id,
        handle: "ledger",
        displayName: "Ledger",
        type: "personal" as const,
        ownerUserId: "tsub_imported_owner",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createSpace: async (req) => ({
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
  expect(operations.calls.listInstallationsPage?.[0]).toEqual("space_ledger");
});

test("POST /api/v1/spaces uses the session subject as ownerUserId", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie, subject } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("POST", "/api/v1/spaces", {
    cookie,
    body: { handle: "myspace", displayName: "My Space", type: "personal" },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const createCall = operations.calls.createSpace?.[0] as {
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
    currentOutputSnapshotId?: string;
  };
  expect(installation.installType).toBeUndefined();
  expect(installation.currentOutputSnapshotId).toBeUndefined();
  expect(operations.calls.listInstallationsPage?.[0]).toEqual("space_a");
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
    installation: { installType?: string; currentOutputSnapshotId?: string };
  };
  expect(body.installation.installType).toBeUndefined();
  expect(body.installation.currentOutputSnapshotId).toBeUndefined();
  const createCall = operations.calls.createInstallation?.[0] as {
    spaceId: string;
  };
  expect(createCall.spaceId).toEqual("space_a");
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
    spaceId: string;
    variableMapping: Record<string, unknown>;
    outputAllowlist: Record<string, unknown>;
  };
  expect(config.id.startsWith("icfg_")).toEqual(true);
  expect(config.spaceId).toEqual("space_a");
  expect(config.variableMapping).toEqual({ project_name: "takos-space-a" });
  expect(config.outputAllowlist).toEqual({
    url: { from: "url", type: "url" },
    worker_name: { from: "worker_name", type: "string" },
  });
  const createCall = operations.calls.createInstallation?.[0] as {
    installConfigId: string;
  };
  expect(createCall.installConfigId).toEqual(config.id);
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
  expect(operations.calls.createInstallation).toBeUndefined();
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
    nodes: Array<{ installationId: string; name: string; status: string }>;
    edges: Array<{
      id: string;
      producerInstallationId: string;
      outputs: unknown;
    }>;
  };
  expect(body.nodes[0]?.installationId).toEqual("inst_1");
  expect(body.nodes[0]?.name).toEqual("app");
  expect(body.edges[0]?.id).toEqual("dep_1");
  expect(body.edges[0]?.producerInstallationId).toEqual("inst_1");
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
    installation: { installType?: string; currentOutputSnapshotId?: string };
  };
  expect(body.installation.installType).toBeUndefined();
  expect(body.installation.currentOutputSnapshotId).toBeUndefined();
  expect(operations.calls.getInstallation?.[0]).toEqual("inst_1");
});

test("POST /api/v1/installations/:id/backups creates an Installation-context backup", async () => {
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
    backup: { spaceId: string; installationId?: string; environment?: string };
  };
  expect(body.backup.spaceId).toEqual("space_a");
  expect(operations.calls.getInstallation?.[0]).toEqual("inst_1");
  expect(operations.calls.createBackup).toEqual([
    {
      spaceId: "space_a",
      installationId: "inst_1",
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
      connections: readonly { connectionId: string }[];
    };
  };
  expect(body.providerConnectionSet.connections[0]?.connectionId).toEqual(
    await publicProviderConnectionIdForTest("penv_cf_gateway"),
  );
  expect(body.providerConnectionSet.connections[0]?.connectionId).not.toEqual(
    "penv_cf_gateway",
  );
  expect(
    operations.calls.getInstallationProviderEnvBindingSetByInstallation,
  ).toEqual(["inst_1", "prod"]);
});

test("PUT /api/v1/installations/:id/provider-connections saves provider connection selections", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    connections: {
      listProviderEnvs: async () => [
        {
          id: "penv_cf",
          spaceId: "space_a",
          providerSource: "registry.opentofu.org/cloudflare/cloudflare",
          displayName: "Cloudflare",
          materialization: "secret",
          status: "ready",
          requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "penv_aws",
          spaceId: "space_a",
          providerSource: "registry.opentofu.org/hashicorp/aws",
          displayName: "AWS",
          materialization: "secret",
          status: "ready",
          requiredEnvNames: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
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
      body: {
        connections: [
          {
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            alias: "main",
            connectionId: await publicProviderConnectionIdForTest("penv_cf"),
          },
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            alias: "archive",
            connectionId: await publicProviderConnectionIdForTest("penv_aws"),
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
  const saved = operations.calls.putInstallationProviderEnvBindingSet?.[0] as {
    bindings: readonly {
      provider: string;
      alias?: string;
      envId: string;
    }[];
  };
  expect(saved.bindings[0]).toEqual({
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    alias: "main",
    envId: "penv_cf",
  });
  expect(saved.bindings[1]).toEqual({
    provider: "registry.opentofu.org/hashicorp/aws",
    alias: "archive",
    envId: "penv_aws",
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
  expect(operations.calls.createInstallationPlan?.[0]).toEqual("inst_1");
  expect(operations.calls.getRun).toContain("plan_1");
  expect(operations.calls.getRunCost).toContain("plan_1");
});

test("GET /api/v1/runs/:id projects provider resolutions to provider connections", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    getRun: async (id) =>
      ({
        id,
        spaceId: "space_a",
        installationId: "inst_1",
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
  expect(raw.includes("penv_cf")).toEqual(false);
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
  expect(resolution?.ownership).toEqual("own_key");
  expect(resolution?.connectionId?.startsWith("pcn_")).toEqual(true);
  expect(resolution?.evidence?.kind).toEqual("provider_connection");
  expect(resolution?.evidence?.connectionId).toEqual(resolution?.connectionId);
});

test("GET /api/v1/runs/:id does not expose legacy operator-backed ownership vocabulary", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    connections: {
      listProviderEnvs: async () => [],
      getProviderEnv: async (id) => ({
        id,
        spaceId: "space_a",
        providerSource: "registry.opentofu.org/cloudflare/cloudflare",
        displayName: "Takosumi provided Cloudflare",
        materialization: "secret",
        status: "ready",
        requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
        secretRef: "conn_operator_secret",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
    getConnection: async (connectionId) =>
      ({
        id: connectionId,
        provider: "cloudflare",
        kind: "cloudflare_api_token",
        authMethod: "static_secret",
        scope: "operator",
        status: "verified",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }) as unknown as Awaited<
        ReturnType<ControlPlaneOperations["getConnection"]>
      >,
    getRun: async (id) =>
      ({
        id,
        spaceId: "space_a",
        installationId: "inst_1",
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
            envId: "penv_operator_backed",
            materialization: "secret",
            evidence: {
              kind: "provider_env",
              provider: "cloudflare",
              envId: "penv_operator_backed",
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
  const body = (await response!.json()) as {
    run: {
      providerResolutions?: readonly {
        ownership?: string;
        evidence?: { ownership?: string };
      }[];
    };
  };
  expect(body.run.providerResolutions?.[0]?.ownership).toEqual("own_key");
  expect(body.run.providerResolutions?.[0]?.evidence?.ownership).toEqual(
    "own_key",
  );
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
        spaceId: "space_a",
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
    run: { id: string; type: string; status: string; spaceId: string };
  };
  expect(body.run).toMatchObject({
    id: "ssr_1",
    type: "source_sync",
    status: "running",
    spaceId: "space_a",
  });
  expect(requestedRunId).toEqual("ssr_1");
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
  expect(operations.calls.createInstallationDestroyPlan?.[0]).toEqual("inst_1");
  expect(operations.calls.getRun).toContain("plan_destroy");
  expect(operations.calls.getRunCost).toContain("plan_destroy");
});

test("Installation session routes patch status, delete via destroy-plan, drift-check, and list dependencies", async () => {
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
  expect(operations.calls.patchInstallationStatus).toEqual(["inst_1", "stale"]);

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
  expect(operations.calls.createInstallationDestroyPlan?.[0]).toEqual("inst_1");

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
  expect(operations.calls.createInstallationDriftCheck?.[0]).toEqual("inst_1");

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
  expect(operations.calls.listForInstallation?.[0]).toEqual("inst_1");
});

test("POST /api/v1/installations/:id/dependencies derives spaceId from the consumer", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/installations/inst_2/dependencies",
    {
      cookie,
      body: {
        producerInstallationId: "inst_1",
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
    consumerInstallationId: string;
    spaceId: string;
    mode: string;
    visibility: string;
  };
  expect(dep.consumerInstallationId).toEqual("inst_2");
  expect(dep.spaceId).toEqual("space_a");
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
  operations.installations.listInstallConfigs = async (spaceId) => {
    operations.calls.listInstallConfigs = [spaceId];
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
      sourceKind?: string;
      installType?: string;
      templateBinding?: unknown;
    }>;
  };
  expect(Array.isArray(body.installConfigs)).toEqual(true);
  expect(body.installConfigs[0]?.sourceKind).toBe("generic_capsule");
  expect(body.installConfigs[0]?.installType).toBeUndefined();
  expect(body.installConfigs[0]?.templateBinding).toBeUndefined();

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

  const legacy = request("GET", "/api/v1/install-configs?spaceId=space_a", {
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

test("Sources: GET requires spaceId, POST + sync return 201", async () => {
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
      spaceId: "space_a",
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
    spaceId: "space_a",
    sourceId: "src_x",
  });

  const compatibility = request(
    "POST",
    "/api/v1/sources/src_x/compatibility-check",
    {
      cookie,
      body: { sourceSnapshotId: "snap_1" },
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
  expect(operations.calls.createSpaceUpdate?.[0]).toEqual("space_a");

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
  expect(operations.calls.createSpaceDriftCheck).toEqual([
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

test("Connections: requires spaceId; provider-connections is Space-gated", async () => {
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
  expect(operations.calls.listProviderEnvs).toBeDefined();
});

test("Connections create: registers a Space-owned connection; token never echoed", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const create = request("POST", "/api/v1/connections", {
    cookie,
    body: {
      spaceId: "space_a",
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

  // The facade was called with a Space-scoped cloudflare_api_token request.
  const passed = operations.calls.createConnection?.[0] as {
    spaceId?: string;
    provider?: string;
    kind?: string;
    scope?: string;
    scopeHints?: { accountId?: string };
    values?: Record<string, string>;
  };
  expect(passed.spaceId).toEqual("space_a");
  expect(passed.provider).toEqual("cloudflare");
  expect(passed.kind).toEqual("cloudflare_api_token");
  // Forced Space scope regardless of the caller-supplied `scope: "operator"`.
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

test("Connections create: registers a Space-owned source Git HTTPS token; token never echoed", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const create = request("POST", "/api/v1/connections", {
    cookie,
    body: {
      spaceId: "space_a",
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
    spaceId?: string;
    provider?: string;
    kind?: string;
    credentialDriver?: string;
    scope?: string;
    scopeHints?: { repoUrl?: string; username?: string };
    values?: Record<string, string>;
  };
  expect(passed.spaceId).toEqual("space_a");
  expect(passed.provider).toEqual("source_git_https_token");
  expect(passed.kind).toEqual("source_git_https_token");
  expect(passed.credentialDriver).toEqual("static_secret");
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
      spaceId: "space_a",
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
    spaceId?: string;
    provider?: string;
    kind?: string;
    credentialDriver?: string;
    scope?: string;
    scopeHints?: { gcpProjectId?: string };
    values?: Record<string, string>;
  };
  expect(passed.spaceId).toEqual("space_a");
  expect(passed.provider).toEqual("google");
  expect(passed.kind).toEqual("gcp_service_account_json");
  expect(passed.credentialDriver).toEqual("gcp_service_account_json");
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
      spaceId: "space_a",
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
    spaceId?: string;
    provider?: string;
    kind?: string;
    credentialDriver?: string;
    scope?: string;
    values?: Record<string, string>;
  };
  expect(passed.spaceId).toEqual("space_a");
  expect(passed.provider).toEqual(provider);
  expect(passed.kind).toEqual("generic_env_provider");
  expect(passed.credentialDriver).toEqual("generic_env");
  expect(passed.scope).toEqual("space");
  expect(passed.values?.SNOWFLAKE_PASSWORD).toEqual("snowflake-secret");

  const text = await response!.text();
  expect(text).not.toContain("snowflake-secret");
  expect(text).not.toContain("SNOWFLAKE_PASSWORD");
});

test("Connections create: honors explicit generic env for guided providers", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const create = request("POST", "/api/v1/connections", {
    cookie,
    body: {
      spaceId: "space_a",
      provider: "cloudflare",
      kind: "generic_env_provider",
      credentialDriver: "generic_env",
      values: {
        CLOUDFLARE_API_TOKEN: "cf-secret-token",
        CLOUDFLARE_ACCOUNT_ID: "acct",
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
    credentialDriver?: string;
    scope?: string;
    values?: Record<string, string>;
  };
  expect(passed.provider).toEqual("cloudflare");
  expect(passed.kind).toEqual("generic_env_provider");
  expect(passed.credentialDriver).toEqual("generic_env");
  expect(passed.scope).toEqual("space");

  const text = await response!.text();
  expect(text).not.toContain("cf-secret-token");
});

test("Connections create: requires spaceId and values", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const noSpace = request("POST", "/api/v1/connections", {
    cookie,
    body: { provider: "cloudflare", values: { CLOUDFLARE_API_TOKEN: "t" } },
  });
  const noSpaceResp = await handleControlRoute({
    request: noSpace.request,
    url: noSpace.url,
    store,
    operations,
  });
  expect(noSpaceResp?.status).toEqual(400);

  const noValues = request("POST", "/api/v1/connections", {
    cookie,
    body: { spaceId: "space_a", provider: "cloudflare", values: {} },
  });
  const noValuesResp = await handleControlRoute({
    request: noValues.request,
    url: noValues.url,
    store,
    operations,
  });
  expect(noValuesResp?.status).toEqual(400);

  const sourceNoToken = request("POST", "/api/v1/connections", {
    cookie,
    body: {
      spaceId: "space_a",
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

test("Connections create: another Space is forbidden (no connection minted)", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      getSpace: async (id) => ({
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
      spaceId: "space_b",
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
    body: { spaceId: "space_a" },
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

test("POST /api/v1/connections/:id/test resolves the Space and re-verifies the connection", async () => {
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
  // Ownership is resolved from the Connection's spaceId before the test runs.
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

test("POST /api/v1/connections/:id/revoke 404s (non-disclosing) for a Space the caller does not own", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The Connection belongs to a Space owned by a different subject -> the
  // ownership gate must answer a non-disclosing connection_not_found, and the
  // revoke must never run.
  const operations = fakeOperations({
    getConnection: async (connectionId) =>
      ({
        id: connectionId,
        spaceId: "space_foreign",
        provider: "cloudflare",
        kind: "cloudflare_api_token",
        authMethod: "static_secret",
        scope: "space",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }) as unknown as ReturnType<ControlPlaneOperations["getConnection"]>,
    spaces: {
      getSpace: async (id) => ({
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

test("Cloudflare OAuth: start authorizes and callback redirects to /connections, minting a Space-owned connection", async () => {
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
              encodeURIComponent(input.spaceId),
            state: "signed",
          };
        },
        complete: async () => ({
          request: {
            spaceId: "space_a",
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
    body: { spaceId: "space_a" },
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

  // A Space-owned connection was created from the OAuth result.
  const passed = operations.calls.createConnection?.[0] as {
    spaceId?: string;
    scope?: string;
  };
  expect(passed.spaceId).toEqual("space_a");
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
            spaceId: "space_a",
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
  // trusted to mint a Connection, even though the spaceId looks owned.
  const store = new InMemoryAccountsStore();
  seedSession(store, { subject: "tsub_ctrl" });
  const operations = fakeOperations({
    connectionOAuth: {
      cloudflare: {
        start: async () => ({ authorizationUrl: "https://x", state: "signed" }),
        complete: async () => ({
          request: {
            spaceId: "space_a",
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

test("Cloudflare OAuth callback: a Space the signed subject does not own is not minted", async () => {
  const store = new InMemoryAccountsStore();
  // Present a cookie too, to prove the gate is the SIGNED subject, not the
  // cookie: the signed subject does not own the Space, so the mint is refused.
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      getSpace: async (id) => ({
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
            // The signed state resolves to a Space owned by someone else.
            spaceId: "space_b",
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

test("OutputShares: list, create, approve, and revoke are Space-gated", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie, subject } = seedSession(store);
  seedLedgerSpace(store, {
    subject,
    accountId: "acct_to",
    spaceId: "space_b",
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
      fromSpaceId: "space_a",
      toSpaceId: "space_b",
      producerInstallationId: "inst_1",
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
      getInstallation: async () => {
        throw Object.assign(new Error("nope"), { code: "not_found" });
      },
      listInstallations: async () => [],
      listInstallationsPage: async () => ({ items: [] }),
      createInstallation: async () => {
        throw new Error("unused");
      },
      listInstallConfigs: async () => [],
      putInstallationProviderEnvBindingSet: async (profile) => profile,
      getInstallationProviderEnvBindingSetByInstallation: async () => undefined,
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

// --- personalSpaceHandle derivation ---------------------------------------

test("personalSpaceHandle prefers displayName, then email, then fallback", () => {
  expect(
    personalSpaceHandle({ subject: "tsub_x", displayName: "Shota Tomiyama" }),
  ).toEqual("shota-tomiyama");
  expect(
    personalSpaceHandle({ subject: "tsub_x", email: "alice.dev@example.com" }),
  ).toEqual("alice-dev");
  // Unusable displayName ("!") falls through to email.
  expect(
    personalSpaceHandle({
      subject: "tsub_x",
      displayName: "!",
      email: "bob@x.io",
    }),
  ).toEqual("bob");
  // No usable candidate -> u-<short subject>.
  const fallback = personalSpaceHandle({ subject: "tsub_AbCdEf123" });
  expect(fallback.startsWith("u-")).toEqual(true);
  expect(/^[a-z0-9][a-z0-9-]{1,38}$/.test(fallback)).toEqual(true);
});

test("personalSpaceHandle clamps to the 39-char handle rule", () => {
  const long = "x".repeat(80);
  const handle = personalSpaceHandle({ subject: "tsub_x", displayName: long });
  expect(handle.length).toBeLessThanOrEqual(39);
  expect(/^[a-z0-9][a-z0-9-]{1,38}$/.test(handle)).toEqual(true);
});

// --- ensurePersonalSpace fire-and-forget hook -----------------------------

test("maybeEnsurePersonalSpaceForSession creates a space for a live session", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store, { displayName: "Shota" });
  const operations = fakeOperations();
  const { request: req } = request("GET", "/v1/account/session/me", { cookie });
  await maybeEnsurePersonalSpaceForSession({ request: req, store, operations });
  const createCall = operations.calls.createSpace?.[0] as {
    handle: string;
    type: string;
    ownerUserId: string;
  };
  expect(createCall.handle).toEqual("shota");
  expect(createCall.type).toEqual("personal");
  expect(createCall.ownerUserId).toEqual("tsub_ctrl");
});

test("maybeEnsurePersonalSpaceForSession swallows a handle-collision error", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store, { displayName: "Shota" });
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      getSpace: async () => {
        throw new Error("unused");
      },
      createSpace: async () => {
        throw Object.assign(new Error("taken"), {
          code: "failed_precondition",
        });
      },
    },
  });
  const { request: req } = request("GET", "/v1/account/session/me", { cookie });
  // Must NOT throw.
  await maybeEnsurePersonalSpaceForSession({ request: req, store, operations });
});

test("maybeEnsurePersonalSpaceForSession is a no-op without a session", async () => {
  const store = new InMemoryAccountsStore();
  const operations = fakeOperations();
  const { request: req } = request("GET", "/v1/account/session/me");
  await maybeEnsurePersonalSpaceForSession({ request: req, store, operations });
  expect(operations.calls.createSpace).toBeUndefined();
});

// --- POST /api/v1/runs/:runId/apply (§31 GUI deploy) ----------------------

test("POST /api/v1/runs/:id/apply applies a succeeded plan for an owned Space", async () => {
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
          spaceId: "space_a",
          status: "queued",
        },
        installation: {
          id: "inst_1",
          spaceId: "space_a",
          name: "app",
          slug: "app",
          sourceId: "src_x",
          installType: "opentofu_module",
          installConfigId: "cfg_x",
          environment: "prod",
          currentDeploymentId: "dep_1",
          currentStateGeneration: 4,
          currentOutputSnapshotId: "osnap_secret_1",
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
  expect(body.installation?.currentOutputSnapshotId).toBeUndefined();
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

test("POST /api/v1/runs/:id/apply rejects a plan from another inaccessible Space", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      // The plan's owning Space (space_b) is owned by a different subject.
      getSpace: async (id) => ({
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
          spaceId: "space_b",
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
  // The plan was resolved (to learn its Space, space_b) but the gate rejects
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

test("maybeEnsurePersonalSpaceForSession is a no-op without an operations facade", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const { request: req } = request("GET", "/v1/account/session/me", { cookie });
  // No operations -> returns quietly.
  await maybeEnsurePersonalSpaceForSession({ request: req, store });
});

// --- Deployments / outputs / rollback (§30 GUI deploy) ---------------------

/**
 * A Deployment ledger row whose `outputsPublic` is the allowlist projection.
 * `outputSnapshotId` points at the raw (un-projected) encrypted OutputSnapshot
 * and MUST be projected out of every session-surface read.
 */
function deploymentRow(
  id: string,
  spaceId: string,
  installationId = "inst_1",
): Record<string, unknown> {
  return {
    id,
    spaceId,
    installationId,
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
  spaceId: string,
  overrides: Parameters<typeof fakeOperations>[0] = {},
): ReturnType<typeof fakeOperations> {
  const operations = fakeOperations(overrides);
  const calls = operations.calls;
  operations.listDeployments = async (installationId: string) => {
    calls.listDeployments = [installationId];
    return {
      deployments: [deploymentRow("dep_1", spaceId, installationId)],
    } as unknown as Awaited<
      ReturnType<ControlPlaneOperations["listDeployments"]>
    >;
  };
  operations.getDeployment = async (id: string) => {
    calls.getDeployment = [id];
    return deploymentRow(id, spaceId) as unknown as Awaited<
      ReturnType<ControlPlaneOperations["getDeployment"]>
    >;
  };
  operations.createDeploymentRollbackPlan = async (deploymentId: string) => {
    calls.createDeploymentRollbackPlan = [deploymentId];
    return {
      planRun: {
        id: "plan_rollback",
        spaceId,
        status: "queued",
        operation: "update",
        installationId: "inst_1",
        rolledBackFromDeploymentId: deploymentId,
      },
    } as unknown as Awaited<
      ReturnType<ControlPlaneOperations["createDeploymentRollbackPlan"]>
    >;
  };
  return operations;
}

function otherSpaceSpaces(): NonNullable<
  Parameters<typeof fakeOperations>[0]
>["spaces"] {
  return {
    getSpace: async (id) => ({
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

test("GET /api/v1/installations/:id/deployments lists deployments for an owned Space", async () => {
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
  // The Installation's Space was resolved server-side for the gate.
  expect(operations.calls.getInstallation).toEqual(["inst_1"]);
  expect(operations.calls.listDeployments).toEqual(["inst_1"]);
  // The raw OutputSnapshot pointer is projected out of every row.
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
  expect(operations.calls.getInstallation).toEqual(["inst_1"]);
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
  // The Installation belongs to space_b, owned by a different subject.
  const operations = deploymentOperations("space_b", {
    spaces: otherSpaceSpaces(),
    installations: {
      getInstallation: async (id) => ({
        id,
        spaceId: "space_b",
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
  // The Deployment was resolved server-side to learn its Space for the gate.
  expect(operations.calls.getDeployment).toEqual(["dep_1"]);
  const body = (await response!.json()) as {
    deployment: Record<string, unknown>;
  };
  // Public outputsPublic is present; the raw OutputSnapshot pointer is gone.
  expect(body.deployment.outputsPublic).toEqual({
    launch_url: "https://app.example.test",
  });
  expect(body.deployment.outputSnapshotId).toBeUndefined();
  // No raw OutputSnapshot handle leaks into the serialized response.
  expect(JSON.stringify(body)).not.toContain("osnap_secret_1");
});

test("GET /api/v1/deployments/:id rejects a deployment in another Space with 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The Deployment belongs to space_b, owned by a different subject.
  const operations = deploymentOperations("space_b", {
    spaces: otherSpaceSpaces(),
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
  // The Deployment was resolved (to learn its Space) but the gate rejects; no
  // projection is returned, so nothing could leak.
  expect(operations.calls.getDeployment).toEqual(["dep_other"]);
});

test("POST /api/v1/deployments/:id/rollback-plan creates a rollback plan for an owned Space", async () => {
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
  // The Deployment's Space was resolved server-side for the gate first.
  expect(operations.calls.getDeployment).toEqual(["dep_1"]);
  expect(operations.calls.createDeploymentRollbackPlan).toEqual(["dep_1"]);
  const body = (await response!.json()) as { run: { id: string } };
  // The response carries the Run that flows through approve -> apply.
  expect(body.run.id).toEqual("plan_rollback");
});

test("POST /api/v1/deployments/:id/rollback-plan rejects a deployment in another Space with 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = deploymentOperations("space_b", {
    spaces: otherSpaceSpaces(),
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

// --- Members (Space membership / roles) ------------------------------------

type MemberRow = {
  id: string;
  spaceId: string;
  accountId: string;
  roles: string[];
  status: "active" | "invited" | "suspended";
  createdAt: string;
  updatedAt: string;
};

/**
 * A `fakeOperations` whose `members` facade is backed by an in-memory roster.
 * `spaceOwner` controls the namespace gate (`requireSpaceAccess`): when it
 * equals the session subject the namespace gate passes, so a 403 there isolates
 * the membership ROLE gate. The roster seeds the per-account roles the route
 * reads to decide the role/last-owner gate.
 */
function memberOperations(options: {
  spaceId: string;
  spaceOwner: string;
  roster: MemberRow[];
}): ControlPlaneOperations & {
  calls: Record<string, unknown[]>;
  roster: MemberRow[];
} {
  const roster = options.roster;
  const base = fakeOperations({
    spaces: {
      getSpace: async (id) => ({
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
    listMembers: async (spaceId) => {
      base.calls.listMembers = [spaceId];
      return roster.filter((member) => member.spaceId === spaceId);
    },
    upsertMember: async (input) => {
      base.calls.upsertMember = [input];
      const now = "2026-02-02T00:00:00Z";
      const existing = roster.find(
        (member) =>
          member.spaceId === input.spaceId &&
          member.accountId === input.accountId,
      );
      const next: MemberRow = {
        id: existing?.id ?? `mem_${input.accountId}`,
        spaceId: input.spaceId,
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
  spaceId = "space_a",
): MemberRow {
  return {
    id: `mem_${accountId}`,
    spaceId,
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
    spaceId: "space_a",
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
  // The spaceId was resolved server-side for the membership read.
  expect(operations.calls.listMembers).toEqual(["space_a"]);
});

test("POST /api/v1/spaces/:id/members lets an owner add a member", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    spaceId: "space_a",
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
  // The spaceId in the upsert is the server-resolved path value, never client body.
  const upsertArg = (
    operations.calls.upsertMember as [Record<string, unknown>]
  )[0];
  expect(upsertArg.spaceId).toEqual("space_a");
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
    spaceId: "space_a",
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
    spaceId: "space_a",
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
    spaceId: "space_a",
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
  // Namespace gate passes (the session subject owns the namespace Space), so a
  // 403 here isolates the membership ROLE gate: a plain member cannot add.
  const operations = memberOperations({
    spaceId: "space_a",
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
    spaceId: "space_a",
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

test("members routes reject a session in another Space with 403 (namespace gate)", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The namespace Space is owned by a DIFFERENT subject; the namespace gate
  // (requireSpaceAccess) rejects before any membership read.
  const operations = memberOperations({
    spaceId: "space_b",
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
    spaceId: "space_a",
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
    spaceId: "space_a",
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
    spaceId: "space_a",
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
    spaceId: "space_a",
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
    spaceId: "space_a",
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
    spaceId: "space_a",
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
    spaceId: "space_a",
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
    spaceId: "space_a",
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
  // passes because the session subject owns the namespace Space).
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
    spaceId: "space_a",
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
  // Space is orphaned.
  const operations = memberOperations({
    spaceId: "space_a",
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
    spaceId: "space_a",
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
    spaceId: "space_a",
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
    spaceId: "space_a",
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
  seedLedgerSpace(store, {
    subject: "tsub_ctrl",
    accountId: "acct_a",
    spaceId: "space_a",
  });
  const operations = memberOperations({
    spaceId: "space_a",
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
