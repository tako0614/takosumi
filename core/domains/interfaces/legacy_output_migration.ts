/**
 * One-time migration from retired runtime Output conventions to Interface.
 *
 * The report is read-only and returns names/digests only. Confirmation is
 * fenced to the exact Capsule, InstallConfig, and current Output reviewed by
 * the operator. Existing Output values are never copied into service config or
 * audit evidence: an Interface keeps an explicit `capsule_output` reference.
 */

import type {
  CapsuleInterfaceBlueprint,
  Interface,
  InterfaceAccessSpec,
  InterfaceSpec,
  JsonValue,
} from "takosumi-contract";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import { redactString } from "../../shared/redaction.ts";
import type { OpenTofuControlStore } from "../deploy-control/store.ts";
import { InterfaceService, InterfaceServiceError } from "./service.ts";

export const RETIRED_RUNTIME_OUTPUT_NAMES = [
  "service_exports",
  "service_bindings",
  "app_deployment",
] as const;

export type RetiredRuntimeOutputName =
  (typeof RETIRED_RUNTIME_OUTPUT_NAMES)[number];

export type LegacyOutputInterfaceMigrationMode =
  "service_blueprints" | "owner_selection_required";

export interface LegacyOutputInterfaceMigrationCandidate {
  readonly capsuleId: string;
  readonly capsuleUpdatedAt: string;
  readonly installConfigId: string;
  readonly installConfigUpdatedAt: string;
  readonly outputId: string;
  readonly outputDigest: string;
  readonly outputNamesDigest: string;
  readonly legacyConventionNames: readonly RetiredRuntimeOutputName[];
  /** Names only. Values never leave the Output resolver boundary. */
  readonly availableOutputNames: readonly string[];
  readonly mode: LegacyOutputInterfaceMigrationMode;
  /** Present only when immutable service-side blueprints are the authority. */
  readonly interfaceBlueprintsDigest?: string;
}

export type LegacyOutputInterfaceMigrationIssueReason =
  | "install_config_missing"
  | "current_output_missing"
  | "current_output_inconsistent"
  | "blueprint_retired"
  | "blueprint_output_missing";

export interface LegacyOutputInterfaceMigrationIssue {
  readonly capsuleId: string;
  readonly reason: LegacyOutputInterfaceMigrationIssueReason;
  readonly detail: string;
  readonly names?: readonly string[];
}

export interface LegacyOutputInterfaceMigrationReport {
  readonly workspaceId: string;
  readonly candidates: readonly LegacyOutputInterfaceMigrationCandidate[];
  /** Durable evidence already recorded for a candidate Capsule. */
  readonly completed: readonly LegacyOutputInterfaceMigrationCompletion[];
  readonly issues: readonly LegacyOutputInterfaceMigrationIssue[];
}

export interface LegacyOutputInterfaceMigrationCompletion {
  readonly capsuleId: string;
  readonly evidenceEventId: string;
  readonly interfaceIds: readonly string[];
}

export interface LegacyOutputInterfaceManualSelection {
  readonly name: string;
  readonly type: string;
  readonly version: string;
  readonly document: JsonValue;
  readonly inputName: string;
  readonly outputName: string;
  readonly pointer?: string;
  readonly access: InterfaceAccessSpec;
}

export interface ConfirmLegacyOutputInterfaceMigrationInput extends LegacyOutputInterfaceMigrationCandidate {
  readonly confirmedBy: string;
  readonly selection?: LegacyOutputInterfaceManualSelection;
}

export interface LegacyOutputInterfaceMigrationResult {
  readonly capsuleId: string;
  readonly outputId: string;
  readonly interfaceIds: readonly string[];
  readonly evidenceEventId: string;
}

export type LegacyOutputInterfaceMigrationErrorCode =
  | "candidate_not_found"
  | "candidate_changed"
  | "invalid_selection"
  | "interface_conflict"
  | "interface_not_ready";

export class LegacyOutputInterfaceMigrationError extends Error {
  constructor(
    readonly code: LegacyOutputInterfaceMigrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LegacyOutputInterfaceMigrationError";
  }
}

export interface LegacyOutputInterfaceMigrationOptions {
  readonly opentofu: OpenTofuControlStore;
  readonly interfaces: InterfaceService;
  readonly now?: () => string;
}

export class LegacyOutputInterfaceMigrationService {
  readonly #opentofu: OpenTofuControlStore;
  readonly #interfaces: InterfaceService;
  readonly #now: () => string;

  constructor(options: LegacyOutputInterfaceMigrationOptions) {
    this.#opentofu = options.opentofu;
    this.#interfaces = options.interfaces;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /** Inventory only. It never materializes an Interface or writes evidence. */
  async report(
    workspaceId: string,
  ): Promise<LegacyOutputInterfaceMigrationReport> {
    const candidates: LegacyOutputInterfaceMigrationCandidate[] = [];
    const completed: LegacyOutputInterfaceMigrationCompletion[] = [];
    const issues: LegacyOutputInterfaceMigrationIssue[] = [];
    const capsules = await this.#opentofu.listCapsules(workspaceId);

    for (const capsule of capsules) {
      if (capsule.status === "destroyed") continue;
      const installConfig = await this.#opentofu.getInstallConfig(
        capsule.installConfigId,
      );
      if (!installConfig) {
        issues.push({
          capsuleId: capsule.id,
          reason: "install_config_missing",
          detail: "Capsule InstallConfig was not found",
        });
        continue;
      }
      if (!capsule.currentOutputId) {
        // A never-applied Capsule has no runtime declaration to migrate.
        if ((installConfig.interfaceBlueprints?.length ?? 0) > 0) {
          issues.push({
            capsuleId: capsule.id,
            reason: "current_output_missing",
            detail: "Capsule has no successful current Output",
          });
        }
        continue;
      }
      const output = await this.#opentofu.getOutput(capsule.currentOutputId);
      if (
        !output ||
        output.workspaceId !== workspaceId ||
        output.capsuleId !== capsule.id
      ) {
        issues.push({
          capsuleId: capsule.id,
          reason: "current_output_inconsistent",
          detail:
            "Capsule current Output pointer does not resolve to its own Output",
        });
        continue;
      }

      const availableOutputNames = Object.keys(output.workspaceOutputs)
        .filter((name) => !secretShapedOutputName(name))
        .sort((left, right) => left.localeCompare(right));
      const legacyConventionNames = RETIRED_RUNTIME_OUTPUT_NAMES.filter(
        (name) =>
          Object.prototype.hasOwnProperty.call(output.workspaceOutputs, name) ||
          Object.prototype.hasOwnProperty.call(output.publicOutputs, name),
      );
      const blueprints = installConfig.interfaceBlueprints ?? [];

      if (blueprints.length === 0 && legacyConventionNames.length === 0) {
        continue;
      }
      if (blueprints.length > 0) {
        const history = await this.#interfaces.list({
          workspaceId,
          ownerKind: "Capsule",
          ownerId: capsule.id,
          includeRetired: true,
        });
        const retiredKeys = blueprints
          .filter((blueprint) =>
            history.some(
              (iface) =>
                iface.metadata.materializedFrom?.source ===
                  "capsule_blueprint" &&
                iface.metadata.materializedFrom.key === blueprint.key &&
                iface.status.phase === "Retired",
            ),
          )
          .map((blueprint) => blueprint.key)
          .sort();
        if (retiredKeys.length > 0) {
          issues.push({
            capsuleId: capsule.id,
            reason: "blueprint_retired",
            detail:
              "A retired Interface is an explicit deny and cannot be recreated by migration",
            names: retiredKeys,
          });
          continue;
        }
        const missingBlueprintKeys = blueprints
          .filter(
            (blueprint) =>
              !history.some(
                (iface) =>
                  iface.metadata.materializedFrom?.source ===
                    "capsule_blueprint" &&
                  iface.metadata.materializedFrom.key === blueprint.key &&
                  iface.status.phase !== "Retired",
              ),
          )
          .map((blueprint) => blueprint.key);
        // A post-v1 Capsule whose declarations are already materialized and
        // which has no retired convention Output needs no migration evidence.
        if (
          legacyConventionNames.length === 0 &&
          missingBlueprintKeys.length === 0
        ) {
          continue;
        }
        const missingOutputNames = referencedCapsuleOutputNames(
          blueprints,
        ).filter((name) => !availableOutputNames.includes(name));
        if (missingOutputNames.length > 0) {
          issues.push({
            capsuleId: capsule.id,
            reason: "blueprint_output_missing",
            detail:
              "Current Output does not contain every non-secret name required by the service-side Interface blueprint",
            names: missingOutputNames,
          });
          continue;
        }
      }

      const candidateBase = {
        capsuleId: capsule.id,
        capsuleUpdatedAt: capsule.updatedAt,
        installConfigId: installConfig.id,
        installConfigUpdatedAt: installConfig.updatedAt,
        outputId: output.id,
        outputDigest: output.outputDigest,
        outputNamesDigest: await stableJsonDigest(availableOutputNames),
        legacyConventionNames,
        availableOutputNames,
      } as const;
      const candidate: LegacyOutputInterfaceMigrationCandidate =
        blueprints.length > 0
          ? {
              ...candidateBase,
              mode: "service_blueprints",
              interfaceBlueprintsDigest: await stableJsonDigest(blueprints),
            }
          : {
              ...candidateBase,
              mode: "owner_selection_required",
            };
      candidates.push(candidate);
      const completion = await this.#findCompletion(workspaceId, candidate);
      if (completion) completed.push(completion);
    }

    return {
      workspaceId,
      candidates: candidates.sort((left, right) =>
        left.capsuleId.localeCompare(right.capsuleId),
      ),
      completed: completed.sort((left, right) =>
        left.capsuleId.localeCompare(right.capsuleId),
      ),
      issues: issues.sort((left, right) =>
        left.capsuleId.localeCompare(right.capsuleId),
      ),
    };
  }

  /**
   * Materializes only the exact reviewed candidate. If evidence persistence
   * fails after Interface creation, retry is safe: blueprint ensure and manual
   * exact-spec adoption are both idempotent.
   */
  async confirm(
    input: ConfirmLegacyOutputInterfaceMigrationInput,
    expectedWorkspaceId?: string,
  ): Promise<LegacyOutputInterfaceMigrationResult> {
    const capsule = await this.#opentofu.getCapsule(input.capsuleId);
    if (!capsule) {
      throw new LegacyOutputInterfaceMigrationError(
        "candidate_not_found",
        `Capsule ${input.capsuleId} was not found`,
      );
    }
    const workspaceId = capsule.workspaceId;
    if (
      expectedWorkspaceId !== undefined &&
      workspaceId !== expectedWorkspaceId
    ) {
      throw new LegacyOutputInterfaceMigrationError(
        "candidate_not_found",
        `Capsule ${input.capsuleId} was not found in the requested Workspace`,
      );
    }
    const report = await this.report(workspaceId);
    const current = report.candidates.find(
      (candidate) => candidate.capsuleId === input.capsuleId,
    );
    if (!current) {
      throw new LegacyOutputInterfaceMigrationError(
        "candidate_not_found",
        `Capsule ${input.capsuleId} has no migratable Output convention candidate`,
      );
    }
    if (!(await sameCandidate(current, input))) {
      throw new LegacyOutputInterfaceMigrationError(
        "candidate_changed",
        `Capsule ${input.capsuleId} changed after operator review; generate a new report`,
      );
    }
    const confirmedBy = requireText(input.confirmedBy, "confirmedBy");
    const installConfig = await this.#opentofu.getInstallConfig(
      current.installConfigId,
    );
    if (!installConfig) {
      throw new LegacyOutputInterfaceMigrationError(
        "candidate_changed",
        "InstallConfig disappeared after migration confirmation",
      );
    }

    let records: readonly Interface[];
    let selectionDigest: string;
    if (current.mode === "service_blueprints") {
      if (input.selection !== undefined) {
        throw new LegacyOutputInterfaceMigrationError(
          "invalid_selection",
          "service-side Interface blueprints cannot be replaced by an owner selection",
        );
      }
      const blueprints = installConfig.interfaceBlueprints ?? [];
      records = await this.#interfaces.ensureCapsuleBlueprints({
        workspaceId,
        capsuleId: current.capsuleId,
        blueprints,
      });
      selectionDigest = await stableJsonDigest(blueprints);
    } else {
      if (!input.selection) {
        throw new LegacyOutputInterfaceMigrationError(
          "invalid_selection",
          "unknown Output conventions require an explicit Interface selection",
        );
      }
      records = [
        await this.#ensureManualSelection(
          workspaceId,
          current,
          input.selection,
        ),
      ];
      selectionDigest = await stableJsonDigest(input.selection);
    }

    const reconciled = await Promise.all(
      records.map((record) => this.#interfaces.reconcile(record.metadata.id)),
    );
    const notReady = reconciled.filter(
      (record) => record.status.phase !== "Resolved",
    );
    if (notReady.length > 0) {
      throw new LegacyOutputInterfaceMigrationError(
        "interface_not_ready",
        `Migrated Interface did not resolve: ${notReady
          .map((record) => record.metadata.name)
          .sort()
          .join(", ")}`,
      );
    }

    const interfaceIds = reconciled
      .map((record) => record.metadata.id)
      .sort((left, right) => left.localeCompare(right));
    const evidenceEventId = await evidenceId({
      capsuleId: current.capsuleId,
      outputId: current.outputId,
      outputDigest: current.outputDigest,
      mode: current.mode,
      selectionDigest,
    });
    await this.#opentofu.putActivityEvent({
      id: evidenceEventId,
      workspaceId,
      actorId: confirmedBy,
      action: "interface.output_convention_migrated",
      targetType: "capsule",
      targetId: current.capsuleId,
      metadata: {
        mode: current.mode,
        installConfigId: current.installConfigId,
        installConfigUpdatedAt: current.installConfigUpdatedAt,
        outputId: current.outputId,
        outputDigest: current.outputDigest,
        outputNamesDigest: current.outputNamesDigest,
        interfaceIds,
        interfaceSpecDigests: await Promise.all(
          reconciled.map((record) => stableJsonDigest(record.spec)),
        ),
        legacyConventionNames: current.legacyConventionNames,
        selectionDigest,
      },
      createdAt: this.#now(),
    });
    return {
      capsuleId: current.capsuleId,
      outputId: current.outputId,
      interfaceIds,
      evidenceEventId,
    };
  }

  async #ensureManualSelection(
    workspaceId: string,
    candidate: LegacyOutputInterfaceMigrationCandidate,
    selection: LegacyOutputInterfaceManualSelection,
  ): Promise<Interface> {
    const outputName = requireText(
      selection.outputName,
      "selection.outputName",
    );
    if (
      secretShapedOutputName(outputName) ||
      !candidate.availableOutputNames.includes(outputName)
    ) {
      throw new LegacyOutputInterfaceMigrationError(
        "invalid_selection",
        "selection.outputName must be a reported non-secret current Output name",
      );
    }
    if (obviousSecretDocumentPath(selection.document)) {
      throw new LegacyOutputInterfaceMigrationError(
        "invalid_selection",
        "selection.document contains a secret-shaped field or private key",
      );
    }
    const spec: InterfaceSpec = {
      type: requireText(selection.type, "selection.type"),
      version: requireText(selection.version, "selection.version"),
      document: selection.document,
      inputs: {
        [requireText(selection.inputName, "selection.inputName")]: {
          source: "capsule_output",
          capsuleId: candidate.capsuleId,
          outputName,
          ...(selection.pointer === undefined
            ? {}
            : { pointer: selection.pointer }),
        },
      },
      access: selection.access,
    };
    const name = requireText(selection.name, "selection.name");
    const history = await this.#interfaces.list({
      workspaceId,
      ownerKind: "Capsule",
      ownerId: candidate.capsuleId,
      includeRetired: true,
    });
    const existing = history.find(
      (record) =>
        record.metadata.name === name && record.status.phase !== "Retired",
    );
    if (existing) {
      if (
        (await stableJsonDigest(existing.spec)) !==
        (await stableJsonDigest(spec))
      ) {
        throw new LegacyOutputInterfaceMigrationError(
          "interface_conflict",
          `Interface ${name} already exists with a different spec`,
        );
      }
      return existing;
    }
    try {
      return await this.#interfaces.create({
        workspaceId,
        name,
        ownerRef: { kind: "Capsule", id: candidate.capsuleId },
        spec,
      });
    } catch (error) {
      if (
        error instanceof InterfaceServiceError &&
        error.code === "already_exists"
      ) {
        throw new LegacyOutputInterfaceMigrationError(
          "interface_conflict",
          `Interface ${name} was created concurrently; generate a new report`,
        );
      }
      throw error;
    }
  }

  async #findCompletion(
    workspaceId: string,
    candidate: Pick<
      LegacyOutputInterfaceMigrationCandidate,
      | "capsuleId"
      | "installConfigId"
      | "installConfigUpdatedAt"
      | "outputId"
      | "outputDigest"
      | "outputNamesDigest"
      | "mode"
      | "interfaceBlueprintsDigest"
    >,
  ): Promise<LegacyOutputInterfaceMigrationCompletion | undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.#opentofu.listActivityEventsForTargetPage(
        workspaceId,
        "capsule",
        candidate.capsuleId,
        { limit: 100, ...(cursor ? { cursor } : {}) },
      );
      for (const event of page.items) {
        if (event.action !== "interface.output_convention_migrated") continue;
        if (
          event.metadata.installConfigId !== candidate.installConfigId ||
          event.metadata.installConfigUpdatedAt !==
            candidate.installConfigUpdatedAt ||
          event.metadata.outputId !== candidate.outputId ||
          event.metadata.outputDigest !== candidate.outputDigest ||
          event.metadata.outputNamesDigest !== candidate.outputNamesDigest ||
          event.metadata.mode !== candidate.mode ||
          (candidate.mode === "service_blueprints" &&
            event.metadata.selectionDigest !==
              candidate.interfaceBlueprintsDigest)
        ) {
          continue;
        }
        const interfaceIds = event.metadata.interfaceIds;
        if (
          !Array.isArray(interfaceIds) ||
          interfaceIds.length === 0 ||
          !interfaceIds.every(
            (id): id is string => typeof id === "string" && id.length > 0,
          )
        ) {
          continue;
        }
        const records = await Promise.all(
          interfaceIds.map(async (id) => {
            try {
              return await this.#interfaces.get(id);
            } catch (error) {
              if (
                error instanceof InterfaceServiceError &&
                error.code === "not_found"
              ) {
                return undefined;
              }
              throw error;
            }
          }),
        );
        if (
          records.some(
            (record) =>
              !record ||
              record.metadata.workspaceId !== workspaceId ||
              record.metadata.ownerRef.kind !== "Capsule" ||
              record.metadata.ownerRef.id !== candidate.capsuleId,
          )
        ) {
          continue;
        }
        return {
          capsuleId: candidate.capsuleId,
          evidenceEventId: event.id,
          interfaceIds: [...interfaceIds].sort((left, right) =>
            left.localeCompare(right),
          ),
        };
      }
      cursor = page.nextCursor;
    } while (cursor);
    return undefined;
  }
}

function referencedCapsuleOutputNames(
  blueprints: readonly CapsuleInterfaceBlueprint[],
): string[] {
  return [
    ...new Set(
      blueprints.flatMap((blueprint) =>
        Object.values(blueprint.spec.inputs ?? {})
          .filter((input) => input.source === "capsule_output")
          .map((input) => input.outputName),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

async function sameCandidate(
  left: LegacyOutputInterfaceMigrationCandidate,
  right: LegacyOutputInterfaceMigrationCandidate,
): Promise<boolean> {
  return (
    left.capsuleId === right.capsuleId &&
    left.capsuleUpdatedAt === right.capsuleUpdatedAt &&
    left.installConfigId === right.installConfigId &&
    left.installConfigUpdatedAt === right.installConfigUpdatedAt &&
    left.outputId === right.outputId &&
    left.outputDigest === right.outputDigest &&
    left.outputNamesDigest === right.outputNamesDigest &&
    left.mode === right.mode &&
    left.interfaceBlueprintsDigest === right.interfaceBlueprintsDigest &&
    (await stableJsonDigest(left.legacyConventionNames)) ===
      (await stableJsonDigest(right.legacyConventionNames)) &&
    (await stableJsonDigest(left.availableOutputNames)) ===
      (await stableJsonDigest(right.availableOutputNames))
  );
}

async function evidenceId(input: {
  readonly capsuleId: string;
  readonly outputId: string;
  readonly outputDigest: string;
  readonly mode: LegacyOutputInterfaceMigrationMode;
  readonly selectionDigest: string;
}): Promise<string> {
  const digest = await stableJsonDigest(input);
  return `act_interface_migration_${digest.slice("sha256:".length, 38)}`;
}

function secretShapedOutputName(name: string): boolean {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return /(?:^|[_-])(token|secret|password|passwd|credential|auth|bearer|session|cookie|api[_-]?key|private[_-]?key|signing[_-]?key)(?:$|[_-])/iu.test(
    normalized,
  );
}

function obviousSecretDocumentPath(value: unknown): string | undefined {
  if (typeof value === "string") {
    return /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/iu.test(value) ||
      redactString(value) !== value
      ? "$"
      : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = obviousSecretDocumentPath(child);
      if (found) return `$[${index}]${found === "$" ? "" : found.slice(1)}`;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (secretShapedOutputName(key)) return `$.${key}`;
    const found = obviousSecretDocumentPath(child);
    if (found) return `$.${key}${found === "$" ? "" : found.slice(1)}`;
  }
  return undefined;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LegacyOutputInterfaceMigrationError(
      "invalid_selection",
      `${field} must be a non-empty string`,
    );
  }
  return value.trim();
}
