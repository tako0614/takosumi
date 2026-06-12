/**
 * Source-management facade (Core Specification §6).
 *
 * A thin collaborator pulled out of `OpenTofuDeploymentController`: every method
 * is pure delegation to the injected {@link SourcesService}, guarded by a single
 * `not_implemented` check when no Source domain is wired. The controller holds
 * one instance and re-exposes these on its public API unchanged, so importers
 * and the `/api` source route layer keep calling the controller surface.
 */

import type { SourcesService } from "../sources/mod.ts";
import type {
  CreateSourceRequest,
  CreateSourceResponse,
  CreateSourceSyncResponse,
  ListSourcesResponse,
  ListSourceSnapshotsResponse,
  PatchSourceRequest,
  Source,
  SourceResponse,
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type {
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
} from "takosumi-contract/capsules";
import type { PageParams } from "takosumi-contract/pagination";
import { OpenTofuControllerError } from "./errors.ts";

/**
 * Collaborator owning the Source lifecycle delegation. When `sourcesService` is
 * absent every method throws `not_implemented`, matching the prior inline
 * `#requireSources()` behavior.
 */
export class SourceManagement {
  readonly #sourcesService?: SourcesService;

  constructor(sourcesService?: SourcesService) {
    this.#sourcesService = sourcesService;
  }

  async createSource(
    request: CreateSourceRequest,
  ): Promise<CreateSourceResponse> {
    return await this.#require().createSource(request);
  }

  async listSources(
    spaceId: string,
    params?: PageParams,
  ): Promise<ListSourcesResponse> {
    return await this.#require().listSources(spaceId, params);
  }

  async getSource(id: string): Promise<SourceResponse> {
    return await this.#require().getSource(id);
  }

  async patchSource(
    id: string,
    patch: PatchSourceRequest,
  ): Promise<SourceResponse> {
    return await this.#require().patchSource(id, patch);
  }

  async createSourceSync(
    sourceId: string,
    options: { readonly dedupe?: boolean } = {},
  ): Promise<CreateSourceSyncResponse> {
    return await this.#require().createSync(sourceId, options);
  }

  async listSourceSnapshots(
    sourceId: string,
  ): Promise<ListSourceSnapshotsResponse> {
    return await this.#require().listSnapshots(sourceId);
  }

  async getSourceSnapshot(id: string): Promise<SourceSnapshot> {
    return await this.#require().getSourceSnapshot(id);
  }

  async recordUploadSnapshot(input: {
    readonly spaceId: string;
    readonly archiveObjectKey: string;
    readonly archiveDigest: string;
    readonly archiveSizeBytes: number;
    readonly path?: string;
    readonly snapshotId?: string;
  }): Promise<SourceSnapshot> {
    return await this.#require().recordUploadSnapshot(input);
  }

  async createSourceCompatibilityCheck(
    sourceId: string,
    request: CreateSourceCompatibilityCheckRequest = {},
  ): Promise<CapsuleCompatibilityReportResponse> {
    return await this.#require().createCompatibilityCheck(sourceId, request);
  }

  async getCompatibilityReport(
    reportId: string,
  ): Promise<CapsuleCompatibilityReportResponse> {
    return await this.#require().getCompatibilityReport(reportId);
  }

  async getSourceSyncRun(id: string): Promise<SourceSyncRun> {
    return await this.#require().getSyncRun(id);
  }

  async listAutoSyncSources(limit: number): Promise<readonly Source[]> {
    return await this.#require().listAutoSyncSources(limit);
  }

  async verifySourceHookSecret(
    sourceId: string,
    presentedSecret: string,
  ): Promise<boolean> {
    return await this.#require().verifyHookSecret(sourceId, presentedSecret);
  }

  /**
   * Resolves the wired {@link SourcesService}. The Source lifecycle and the
   * `source_sync` consumer path are unavailable without it (Core Specification
   * §6); callers get `not_implemented` rather than a null dereference.
   */
  require(): SourcesService {
    return this.#require();
  }

  #require(): SourcesService {
    if (!this.#sourcesService) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "sources service is not configured",
      );
    }
    return this.#sourcesService;
  }
}
