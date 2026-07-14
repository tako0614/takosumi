/** Read-only Capsule, StateVersion, Output, and ApplyRun projections. */
import type {
  ApplyRunResponse,
  GetCapsuleResponse,
  GetStateVersionResponse,
  ListStateVersionsResponse,
} from "@takosumi/internal/deploy-control-api";
import type { Capsule, PublicCapsule } from "takosumi-contract/capsules";
import {
  CURRENT_OUTPUT_INCONSISTENT_REASON,
  type Output,
  type OutputResponse,
  type PublicOutput,
} from "takosumi-contract/outputs";
import type { PageParams } from "takosumi-contract/pagination";
import type { OpenTofuControlStore } from "./store.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";

export type PublicCapsuleProjector = (capsule: Capsule) => PublicCapsule;

export async function requireCapsule(
  store: OpenTofuControlStore,
  id: string,
): Promise<Capsule> {
  requireNonEmptyString(id, "capsuleId");
  const capsule = await store.getCapsule(id);
  if (!capsule) {
    throw new OpenTofuControllerError("not_found", `capsule ${id} not found`);
  }
  return capsule;
}

export class CapsuleQuery {
  readonly #store: OpenTofuControlStore;
  readonly #publicCapsule: PublicCapsuleProjector;

  constructor(
    store: OpenTofuControlStore,
    publicCapsule: PublicCapsuleProjector,
  ) {
    this.#store = store;
    this.#publicCapsule = publicCapsule;
  }

  async getApplyRun(id: string): Promise<ApplyRunResponse> {
    requireNonEmptyString(id, "applyRunId");
    const applyRun = await this.#store.getApplyRun(id);
    if (!applyRun) {
      throw new OpenTofuControllerError(
        "not_found",
        `apply run ${id} not found`,
      );
    }
    const capsule = applyRun.capsuleId
      ? await this.#store.getCapsule(applyRun.capsuleId)
      : undefined;
    const publicCapsule = capsule ? this.#publicCapsule(capsule) : undefined;
    return {
      applyRun,
      ...(publicCapsule ? { capsule: publicCapsule } : {}),
    };
  }

  async getCapsule(id: string): Promise<GetCapsuleResponse> {
    const capsule = this.#publicCapsule(await requireCapsule(this.#store, id));
    return { capsule };
  }

  /**
   * Reads the Output selected by a Capsule's internal current cursor.
   * Missing or cross-Capsule/cross-Workspace rows are corruption, not an empty
   * result: fail closed so callers never display an unrelated projection.
   */
  async getCurrentOutput(capsuleId: string): Promise<OutputResponse> {
    const capsule = await requireCapsule(this.#store, capsuleId);
    const outputId = capsule.currentOutputId;
    if (!outputId) return { output: null };

    const output = await this.#store.getOutput(outputId);
    if (!isCurrentOutputForCapsule(output, capsule, outputId)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `capsule ${capsule.id} current Output is inconsistent`,
        { reason: CURRENT_OUTPUT_INCONSISTENT_REASON },
      );
    }
    return { output: publicOutput(output) };
  }

  async listActiveCapsules(limit: number): Promise<readonly Capsule[]> {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const all = await this.#store.listCapsules();
    return all
      .filter((capsule) => capsule.status === "active")
      .slice(0, Math.floor(limit));
  }

  async listStateVersions(
    capsuleId: string,
    params?: PageParams,
  ): Promise<ListStateVersionsResponse> {
    const capsule = await requireCapsule(this.#store, capsuleId);
    const { items, nextCursor } = await this.#store.listStateVersionsPage(
      capsule.id,
      capsule.environment,
      params ?? {},
    );
    return {
      stateVersions: items,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  async listStateVersionsByWorkspace(
    workspaceId: string,
  ): Promise<
    readonly import("takosumi-contract/state-versions").StateVersion[]
  > {
    requireNonEmptyString(workspaceId, "workspaceId");
    return await this.#store.listStateVersionsByWorkspace(workspaceId);
  }

  async listStateVersionsByIds(
    ids: readonly string[],
  ): Promise<
    readonly import("takosumi-contract/state-versions").StateVersion[]
  > {
    const rows = await Promise.all(
      [...new Set(ids.filter(Boolean))].map((id) =>
        this.#store.getStateVersion(id),
      ),
    );
    return rows.filter(
      (row): row is import("takosumi-contract/state-versions").StateVersion =>
        row !== undefined,
    );
  }

  async getStateVersion(id: string): Promise<GetStateVersionResponse> {
    requireNonEmptyString(id, "stateVersionId");
    const stateVersion = await this.#store.getStateVersion(id);
    if (!stateVersion) {
      throw new OpenTofuControllerError(
        "not_found",
        `state version ${id} not found`,
      );
    }
    return { stateVersion };
  }
}

function isCurrentOutputForCapsule(
  output: Output | undefined,
  capsule: Capsule,
  outputId: string,
): output is Output {
  return Boolean(
    output &&
    output.id === outputId &&
    output.workspaceId === capsule.workspaceId &&
    output.capsuleId === capsule.id &&
    output.stateGeneration === capsule.currentStateGeneration,
  );
}

function publicOutput(output: Output): PublicOutput {
  const { rawArtifactRef: _rawArtifactRef, ...publicRecord } = output;
  return publicRecord;
}
