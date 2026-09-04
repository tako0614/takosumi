/** Operator-only, create-only self-host Capsule configuration import. */

import type { CapsulesService } from "../domains/capsules/mod.ts";
import type { Capsule, InstallConfig } from "takosumi-contract/install-configs";
import type { JsonValue } from "takosumi-contract";
import { normalizeCompatibilityReportModulePath } from "takosumi-contract/capsules";
import { stableJsonDigest } from "../adapters/source/digest.ts";
import { OpenTofuControllerError } from "../domains/deploy-control/errors.ts";
import { defaultProjectId } from "../domains/projects/mod.ts";
import {
  defineRoute,
  type DeployControlEndpoint,
  type DeployControlRouteContext,
  ensureOperationPermission,
  ensureRunnerProfilePermission,
  ensureWorkspacePermission,
  readJsonBody,
} from "./deploy_control_shared.ts";
import { TAKOSUMI_CAPSULE_CONFIGURATION_RESTORES_ROUTE } from "./deploy_control_route_paths.ts";

export const CAPSULE_CONFIGURATION_RESTORE_KIND =
  "takosumi.capsule-configuration-restore@v1" as const;

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_IDEMPOTENCY_KEY_BYTES = 256;
const CONFIGURATION_KEYS = new Set([
  "modulePath",
  "sourceBuild",
  "lifecycleActions",
  "runnerId",
  "variableMapping",
  "variablePresentation",
  "installExperience",
  "outputAllowlist",
  "policy",
  "store",
  "interfaceBlueprints",
  "requiredInterfaces",
  "runtimeBindingMaterialization",
]);

type RestoreConfiguration = Pick<
  InstallConfig,
  "variableMapping" | "outputAllowlist" | "policy"
> &
  Partial<
    Pick<
      InstallConfig,
      | "modulePath"
      | "sourceBuild"
      | "lifecycleActions"
      | "runnerId"
      | "variablePresentation"
      | "installExperience"
      | "store"
      | "interfaceBlueprints"
      | "requiredInterfaces"
      | "runtimeBindingMaterialization"
    >
  >;

interface CapsuleConfigurationRestoreRequest {
  readonly kind: typeof CAPSULE_CONFIGURATION_RESTORE_KIND;
  readonly bundleDigest: string;
  readonly migrationId: string;
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly sourceSnapshotId: string;
  readonly compatibilityCheckRunId: string;
  readonly compatibilityReportId: string;
  readonly capsule: {
    readonly name: string;
    readonly environment: string;
    readonly autoUpdate?: boolean;
  };
  readonly configuration: RestoreConfiguration;
  /** Self-host archives never carry provider credentials or bindings. */
  readonly providerBindings: readonly [];
}

export const DEPLOY_CONTROL_CAPSULE_RESTORE_ENDPOINTS: readonly DeployControlEndpoint[] =
  [
    {
      method: "POST",
      path: TAKOSUMI_CAPSULE_CONFIGURATION_RESTORES_ROUTE,
      summary:
        "Atomically imports one immutable self-host Capsule configuration and creates its exact review-only Plan.",
      auth: "deploy-control-token",
      operationId: "restoreCapsuleConfiguration",
      openapi: {
        requestSchema: "CapsuleConfigurationRestoreRequest",
        okStatus: "201",
        okSchema: "CapsuleConfigurationRestoreResponse",
      },
      notImplementedMessage: "capsule configuration restore not wired",
    },
  ];

export function mountDeployControlCapsuleRestoreRoutes(
  ctx: DeployControlRouteContext,
): void {
  const capsules = ctx.dependencies.capsulesService;
  ctx.app.post(
    TAKOSUMI_CAPSULE_CONFIGURATION_RESTORES_ROUTE,
    ctx.deployControlBodyLimit,
    defineRoute({
      ctx,
      requireService: requireCapsules,
      enforceBody: true,
      handler: async ({ c, principal }) => {
        if (principal.workspaceIds !== "*") {
          throw new OpenTofuControllerError(
            "permission_denied",
            "Capsule configuration restore requires an unrestricted operator",
          );
        }
        const body = await readJsonBody<CapsuleConfigurationRestoreRequest>(
          c,
          "capsuleConfigurationRestore",
        );
        const key = c.req.header("idempotency-key")?.trim();
        validateRequest(body, key);
        ensureWorkspacePermission(principal, body.workspaceId);
        ensureOperationPermission(principal, "create");
        if (body.configuration.runnerId) {
          ensureRunnerProfilePermission(principal, body.configuration.runnerId);
        }

        const requestDigest = await stableJsonDigest(body);
        const idempotencyKeyHash = await stableJsonDigest(key!);
        const identityDigest = await stableJsonDigest({
          kind: CAPSULE_CONFIGURATION_RESTORE_KIND,
          idempotencyKeyHash,
        });
        const suffix = identityDigest.replace(/^sha256:/u, "").slice(0, 16);
        const capsuleId = `cap_${suffix}`;
        const installConfigId = `icfg_${requestDigest
          .replace(/^sha256:/u, "")
          .slice(0, 16)}`;
        const planRunId = `plan_${suffix}`;

        const { source } = await ctx.controller.getSource(body.sourceId);
        if (source.workspaceId !== body.workspaceId || source.status !== "active") {
          throw new OpenTofuControllerError(
            "failed_precondition",
            "restore Source is not active in the target Workspace",
          );
        }
        const snapshot = await ctx.controller.getSourceSnapshot(
          body.sourceSnapshotId,
        );
        if (
          snapshot.workspaceId !== body.workspaceId ||
          snapshot.sourceId !== source.id ||
          snapshot.url !== source.url ||
          snapshot.path !== source.defaultPath
        ) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            "restore SourceSnapshot does not match the exact target Source coordinate",
          );
        }
        const [compatibility, compatibilityRun] = await Promise.all([
          ctx.controller.getCompatibilityReport(body.compatibilityReportId),
          ctx.controller.getRun(body.compatibilityCheckRunId),
        ]);
        const report = compatibility.report;
        if (
          compatibilityRun.type !== "compatibility_check" ||
          compatibilityRun.status !== "succeeded" ||
          compatibilityRun.workspaceId !== body.workspaceId ||
          compatibilityRun.sourceId !== source.id ||
          compatibilityRun.sourceSnapshotId !== snapshot.id ||
          compatibilityRun.compatibilityReportId !== report.id ||
          report.id !== body.compatibilityReportId ||
          report.sourceId !== source.id ||
          report.sourceSnapshotId !== snapshot.id ||
          report.capsuleId !== undefined ||
          report.level !== "ready" ||
          normalizeCompatibilityReportModulePath(report.modulePath) !==
            normalizeCompatibilityReportModulePath(
              body.configuration.modulePath,
            )
        ) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            "restore compatibility evidence is not the exact successful preflight",
          );
        }

        let existingConfig: InstallConfig | undefined;
        try {
          existingConfig = await capsules!.getInstallConfig(installConfigId);
        } catch (error) {
          if (
            !(error instanceof OpenTofuControllerError) ||
            error.code !== "not_found"
          ) {
            throw error;
          }
        }
        const createdAt = existingConfig?.createdAt ?? new Date().toISOString();
        const installConfig: InstallConfig = {
          id: installConfigId,
          workspaceId: body.workspaceId,
          name: `${body.capsule.name}-migration-restore`,
          ...body.configuration,
          sourceSelector: {
            url: snapshot.url,
            path: snapshot.path,
          },
          internal: {
            reason: "per_install_overrides",
            migrationRestore: {
              bundleDigest: body.bundleDigest,
              migrationId: body.migrationId,
              idempotencyKeyHash,
              requestDigest,
              sourceSnapshotId: snapshot.id,
              compatibilityCheckRunId: compatibilityRun.id,
              compatibilityReportId: report.id,
              actorSubject: principal.actor,
            },
          },
          createdAt,
          updatedAt: createdAt,
        };
        const candidateCapsule: Capsule = {
          id: capsuleId,
          workspaceId: body.workspaceId,
          projectId: defaultProjectId(body.workspaceId),
          name: body.capsule.name,
          slug: body.capsule.name,
          environment: body.capsule.environment,
          sourceId: source.id,
          installConfigId,
          installingPrincipalId: principal.actor,
          currentStateGeneration: 0,
          status: "pending",
          ...(body.capsule.autoUpdate === true ? { autoUpdate: true } : {}),
          createdAt,
          updatedAt: createdAt,
        };
        const existingPlanBeforeAuthority = await optionalPlanRun(ctx, planRunId);
        if (!existingPlanBeforeAuthority) {
          await ctx.controller.validateCapsuleConfigurationProviderBindings({
            capsule: candidateCapsule,
            installConfig,
            compatibilityReport: report,
            providerBindings: [],
          });
        }
        let planRun = existingPlanBeforeAuthority;
        const ordinaryReplay = planRun !== undefined;
        let capsule;
        if (planRun) {
          capsule = await capsules!.getCapsule(capsuleId);
          const bindingSet = await capsules!.getProviderBindingSetByCapsule(
            capsuleId,
            body.capsule.environment,
          );
          const epoch = await capsules!.getCapsuleExecutionAuthorityEpoch(
            capsuleId,
          );
          if (
            !existingConfig ||
            (await stableJsonDigest(existingConfig)) !==
              (await stableJsonDigest(installConfig)) ||
            capsule.workspaceId !== body.workspaceId ||
            capsule.sourceId !== source.id ||
            capsule.installConfigId !== installConfigId ||
            capsule.name !== body.capsule.name ||
            capsule.environment !== body.capsule.environment ||
            capsule.installingPrincipalId !== principal.actor ||
            (capsule.autoUpdate === true) !==
              (body.capsule.autoUpdate === true) ||
            !bindingSet ||
            bindingSet.id !== `dpf_${suffix}` ||
            bindingSet.workspaceId !== body.workspaceId ||
            bindingSet.capsuleId !== capsuleId ||
            bindingSet.environment !== body.capsule.environment ||
            bindingSet.bindings.length !== 0 ||
            epoch !== 1
          ) {
            throw new OpenTofuControllerError(
              "failed_precondition",
              "restore replay conflicts with durable initial authority",
            );
          }
        } else {
          const initial = await capsules!.createCapsuleInitialAuthority({
            capsuleId,
            workspaceId: body.workspaceId,
            name: body.capsule.name,
            environment: body.capsule.environment,
            sourceId: source.id,
            installingPrincipalId: principal.actor,
            ...(body.capsule.autoUpdate === true ? { autoUpdate: true } : {}),
            installConfig,
            providerBindingSetId: `dpf_${suffix}`,
            providerBindings: [],
          });
          capsule = initial.capsule;
        }
        const planAuthorityEpoch =
          await capsules!.getCapsuleExecutionAuthorityEpoch(capsule.id);
        if (
          capsule.installConfigId !== installConfigId ||
          capsule.currentStateGeneration !== 0 ||
          capsule.currentStateVersionId !== undefined ||
          planAuthorityEpoch !== 1
        ) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            "restore initial authority advanced before Plan creation",
          );
        }
        if (!planRun) {
          try {
            const created = await ctx.controller.createCapsulePlan(
              capsule.id,
              { actor: principal.actor },
              {
                sourceSnapshotId: snapshot.id,
                compatibilityReportId: report.id,
                planRunId,
                expectedCapsulePlanAuthority: {
                  installConfigId,
                  executionAuthorityEpoch: planAuthorityEpoch,
                  currentStateGeneration: 0,
                  currentStateVersionId: undefined,
                },
              },
            );
            planRun = (await ctx.controller.getPlanRun(created.planRun.id)).planRun;
          } catch (error) {
            planRun = await optionalPlanRun(ctx, planRunId);
            if (!planRun) throw error;
          }
        }
        assertPlanRun(planRun, {
          planRunId,
          workspaceId: body.workspaceId,
          capsuleId: capsule.id,
          sourceSnapshotId: snapshot.id,
          compatibilityReportId: report.id,
          actorSubject: principal.actor,
          environment: body.capsule.environment,
          sourceUrl: snapshot.url,
          sourceCommit: snapshot.resolvedCommit,
          modulePath: body.configuration.modulePath,
          runnerProfileId: body.configuration.runnerId,
          executionAuthorityEpoch: planAuthorityEpoch,
        });
        return c.json(
          {
            restore: {
              kind: CAPSULE_CONFIGURATION_RESTORE_KIND,
              bundleDigest: body.bundleDigest,
              requestDigest,
              capsuleId: capsule.id,
              installConfigId,
              planRunId,
              replayed: ordinaryReplay,
            },
            links: { run: `/api/v1/runs/${encodeURIComponent(planRunId)}` },
          },
          ordinaryReplay ? 200 : 201,
        );
      },
    }),
  );

  function requireCapsules(): string | undefined {
    return capsules ? undefined : "capsule configuration restore not wired";
  }
}

function validateRequest(
  body: CapsuleConfigurationRestoreRequest,
  key: string | undefined,
): void {
  if (
    body.kind !== CAPSULE_CONFIGURATION_RESTORE_KIND ||
    !DIGEST.test(body.bundleDigest) ||
    !key ||
    new TextEncoder().encode(key).byteLength > MAX_IDEMPOTENCY_KEY_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(key) ||
    body.migrationId !== key ||
    !bounded(body.workspaceId, 128) ||
    !bounded(body.sourceId, 128) ||
    !bounded(body.sourceSnapshotId, 128) ||
    !bounded(body.compatibilityCheckRunId, 128) ||
    !bounded(body.compatibilityReportId, 128) ||
    !isRecord(body.capsule) ||
    !onlyKeys(body.capsule, ["name", "environment", "autoUpdate"]) ||
    !bounded(body.capsule.name, 128) ||
    !bounded(body.capsule.environment, 128) ||
    (body.capsule.autoUpdate !== undefined &&
      typeof body.capsule.autoUpdate !== "boolean") ||
    !isRecord(body.configuration) ||
    !onlyKeys(body.configuration, CONFIGURATION_KEYS) ||
    !isJsonRecord(body.configuration.variableMapping) ||
    !isRecord(body.configuration.outputAllowlist) ||
    !isRecord(body.configuration.policy) ||
    !Array.isArray(body.providerBindings) ||
    body.providerBindings.length !== 0
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "Capsule configuration restore request is invalid or not provider-neutral",
    );
  }
}

async function optionalPlanRun(
  ctx: DeployControlRouteContext,
  id: string,
) {
  try {
    return (await ctx.controller.getPlanRun(id)).planRun;
  } catch (error) {
    if (error instanceof OpenTofuControllerError && error.code === "not_found") {
      return undefined;
    }
    throw error;
  }
}

function assertPlanRun(
  run: Awaited<
    ReturnType<DeployControlRouteContext["controller"]["getPlanRun"]>
  >["planRun"],
  expected: {
    readonly planRunId: string;
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly sourceSnapshotId: string;
    readonly compatibilityReportId: string;
    readonly actorSubject: string;
    readonly environment: string;
    readonly sourceUrl: string;
    readonly sourceCommit: string;
    readonly modulePath: string | undefined;
    readonly runnerProfileId: string | undefined;
    readonly executionAuthorityEpoch: number;
  },
): void {
  if (
    run.id !== expected.planRunId ||
    run.workspaceId !== expected.workspaceId ||
    run.capsuleId !== expected.capsuleId ||
    run.sourceSnapshotId !== expected.sourceSnapshotId ||
    run.compatibilityReportId !== expected.compatibilityReportId ||
    run.createdBy !== expected.actorSubject ||
    run.operation !== "create" ||
    run.capsuleExecutionAuthorityEpoch !== expected.executionAuthorityEpoch ||
    (run.capsuleCurrentStateVersionId ?? null) !== null ||
    run.baseStateGeneration !== 0 ||
    !run.capsuleContext ||
    run.capsuleContext.workspaceId !== expected.workspaceId ||
    run.capsuleContext.capsuleId !== expected.capsuleId ||
    run.capsuleContext.environment !== expected.environment ||
    run.source.kind !== "git" ||
    run.source.url !== expected.sourceUrl ||
    run.source.commit?.toLowerCase() !== expected.sourceCommit.toLowerCase() ||
    normalizeCompatibilityReportModulePath(run.source.modulePath) !==
      normalizeCompatibilityReportModulePath(expected.modulePath) ||
    (expected.runnerProfileId !== undefined &&
      run.runnerProfileId !== expected.runnerProfileId)
  ) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "restore Plan identity conflicts with durable authority",
    );
  }
}

function bounded(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(
  value: Record<string, unknown>,
  keys: Iterable<string>,
): boolean {
  const allowed = keys instanceof Set ? keys : new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isJsonRecord(
  value: unknown,
): value is Readonly<Record<string, JsonValue>> {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
