/**
 * Storage-grant mint broker — the bind-time issuer behind a
 * `takos.storage.object` consume.
 *
 * When a CONSUMER installation runs, this resolves whether it consumes the
 * workspace storage service, finds the PRODUCER (`takos-storage`) installation
 * in the same workspace, decrypts the producer's sealed signing key, mints a
 * scoped access token bounded to the consumer's own key prefix + verb set, and
 * returns the `TF_VAR_*` env to inject into the run.
 *
 * The consumer's `consume` declaration is an OpenTofu OUTPUT, so it is read from
 * the consumer's LATEST OutputSnapshot (its previous apply). A consumer's first
 * apply therefore carries no storage grant (the `takos-storage` binding is
 * optional and inert until a URL/token is injected); the grant activates on the
 * next run once the consume is declared. This mirrors how sealed sensitive
 * outputs are consumed by {@link DependencyResolutionService}.
 *
 * PRODUCER TRUST: any installable Capsule is arbitrary Git, so a same-workspace
 * Capsule could impersonate the storage publication (export the name + a forged
 * signing key) to become a confused-deputy backend. Producer selection is
 * therefore PINNED: an installation created from the official takos-storage
 * InstallConfig is trusted; otherwise a lone non-official exporter is accepted
 * (self-host single-storage), but ANY ambiguity (multiple candidates) fails
 * CLOSED — no grant is minted.
 *
 * FAIL-OPEN: storage is an optional backend, so this never blocks a consumer
 * apply. All resolution is wrapped so a decrypt failure, another app's malformed
 * output, or a store error yields "no grant" rather than a failed run.
 *
 * Like the {@link RunCredentialBroker}, the returned env is attached to the
 * runner dispatch ONLY — never persisted, never logged — and rides the same
 * dispatch-only credential channel (excluded from the plan-content digest).
 */

import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { JsonValue } from "../../../contract/types.ts";
import { projectServicesFromOutputs } from "../output-projection/service-projection.ts";
import {
  issueStorageWorkspaceGrants,
  STORAGE_OBJECT_PUBLICATION,
} from "../output-projection/storage-grant.ts";
import type {
  ProjectedServiceBinding,
  ProjectedServiceExport,
} from "../output-projection/service-projection.ts";
import type { SensitiveOutputResolver } from "../output-shares/mod.ts";
import type { OpenTofuDeploymentStore } from "./store.ts";

const SIGNING_KEY_OUTPUT_NAME = "takos_storage_signing_key";

/** The official catalog InstallConfig id for the takos-storage producer. */
const OFFICIAL_STORAGE_INSTALL_CONFIG_ID = "cfg-catalog-takos-storage";

// Well-known OpenTofu input variables a storage consumer (e.g. takos-office)
// declares; the runner admits only `TF_VAR_*` names into the sandbox env.
const TF_VAR_API_URL = "TF_VAR_takos_object_api_url";
const TF_VAR_ACCESS_TOKEN = "TF_VAR_takos_object_access_token";
const TF_VAR_KEY_PREFIX = "TF_VAR_takos_object_key_prefix";

export interface StorageGrantBrokerDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId: (prefix: string) => string;
  readonly now: () => number;
  /** Host-injected resolver that decrypts the producer's sealed signing key. */
  readonly sensitiveOutputResolver?: SensitiveOutputResolver;
  /** Optional log sink for fail-open diagnostics. */
  readonly onSkip?: (reason: string, detail: Record<string, unknown>) => void;
}

type StoreOutputSnapshot = NonNullable<
  Awaited<ReturnType<OpenTofuDeploymentStore["getLatestOutputSnapshot"]>>
>;

interface ResolvedStorageProducer {
  readonly installationId: string;
  readonly output: StoreOutputSnapshot;
  readonly export: ProjectedServiceExport;
  readonly official: boolean;
}

export class StorageGrantBroker {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #sensitiveOutputResolver?: SensitiveOutputResolver;
  readonly #onSkip?: (reason: string, detail: Record<string, unknown>) => void;

  constructor(dependencies: StorageGrantBrokerDependencies) {
    this.#store = dependencies.store;
    this.#newId = dependencies.newId;
    this.#now = dependencies.now;
    this.#sensitiveOutputResolver = dependencies.sensitiveOutputResolver;
    this.#onSkip = dependencies.onSkip;
  }

  /**
   * Returns the `TF_VAR_*` env to inject for a consumer's storage grant, or
   * `undefined` when the run does not consume workspace storage, no trusted
   * producer resolves, or resolution fails. Never throws (fail-open).
   */
  async mintStorageGrantEnv(
    planRun: PlanRun,
    phase: "plan" | "apply" | "destroy",
    auditRunId: string,
  ): Promise<Record<string, string> | undefined> {
    try {
      return await this.#resolveStorageGrantEnv(planRun, phase, auditRunId);
    } catch (error) {
      this.#skip("storage_grant_resolution_error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async #resolveStorageGrantEnv(
    planRun: PlanRun,
    phase: "plan" | "apply" | "destroy",
    auditRunId: string,
  ): Promise<Record<string, string> | undefined> {
    if (phase === "destroy") return undefined;
    const workspaceId = planRun.workspaceId ?? planRun.spaceId;
    const consumerInstallationId =
      planRun.installationContext?.installationId ?? planRun.installationId;
    if (!workspaceId || !consumerInstallationId) return undefined;

    const consumerBindings = await this.#consumerStorageBindings(
      consumerInstallationId,
    );
    if (consumerBindings.length === 0) return undefined;

    const producer = await this.#findProducer(
      workspaceId,
      consumerInstallationId,
    );
    if (!producer) return undefined;

    if (!this.#sensitiveOutputResolver) return undefined;
    const signingKey = await this.#sensitiveOutputResolver.resolve({
      outputSnapshot: producer.output,
      outputName: SIGNING_KEY_OUTPUT_NAME,
      fromSpaceId: workspaceId,
      toSpaceId: workspaceId,
      producerInstallationId: producer.installationId,
    });
    if (
      !signingKey ||
      typeof signingKey.value !== "string" ||
      signingKey.value.length === 0
    ) {
      this.#skip("producer_signing_key_unresolved", {
        producerInstallationId: producer.installationId,
      });
      return undefined;
    }

    const grants = await issueStorageWorkspaceGrants(
      consumerBindings,
      { export: producer.export, signingKey: signingKey.value },
      { workspaceId, consumerInstallationId },
      { now: this.#now },
    );
    const grant = grants[0];
    if (!grant) return undefined;

    const env: Record<string, string> = {
      [TF_VAR_ACCESS_TOKEN]: grant.token,
      [TF_VAR_KEY_PREFIX]: grant.prefix,
    };
    if (grant.apiUrl) env[TF_VAR_API_URL] = grant.apiUrl;

    await this.#recordMintEvidence({
      phase,
      auditRunId,
      workspaceId,
      consumerInstallationId,
      producerInstallationId: producer.installationId,
      expiresAt: grant.expiresAt,
    });

    return env;
  }

  async #consumerStorageBindings(
    consumerInstallationId: string,
  ): Promise<readonly ProjectedServiceBinding[]> {
    const output = await this.#store.getLatestOutputSnapshot(
      consumerInstallationId,
    );
    if (!output) return [];
    let bindings: readonly ProjectedServiceBinding[];
    try {
      bindings = projectServicesFromOutputs(
        output.workspaceOutputs as Readonly<Record<string, JsonValue>>,
        { allowExtensionCapabilities: true },
      ).serviceBindings;
    } catch {
      // A malformed consumer output must not block the consumer's own run.
      return [];
    }
    return bindings.filter(
      (binding) =>
        binding.selector.name === STORAGE_OBJECT_PUBLICATION ||
        binding.selector.serviceExportId === STORAGE_OBJECT_PUBLICATION ||
        binding.selector.capabilities.includes("storage.object"),
    );
  }

  /**
   * Resolves the trusted storage producer in the workspace. Prefers an
   * installation created from the official takos-storage InstallConfig; falls
   * back to a lone non-official exporter (self-host). Any ambiguity (0 or >1
   * candidate after preference) fails CLOSED.
   */
  async #findProducer(
    workspaceId: string,
    consumerInstallationId: string,
  ): Promise<ResolvedStorageProducer | undefined> {
    const installations = await this.#store.listInstallations(workspaceId);
    const exporters: ResolvedStorageProducer[] = [];
    for (const installation of installations) {
      if (installation.id === consumerInstallationId) continue;
      const output = await this.#store.getLatestOutputSnapshot(installation.id);
      if (!output) continue;
      let serviceExports: readonly ProjectedServiceExport[];
      try {
        serviceExports = projectServicesFromOutputs(
          output.workspaceOutputs as Readonly<Record<string, JsonValue>>,
          { allowExtensionCapabilities: true },
        ).serviceExports;
      } catch {
        // Another app's malformed output must not abort producer discovery.
        continue;
      }
      const storageExport = serviceExports.find(
        (exported) => exported.name === STORAGE_OBJECT_PUBLICATION,
      );
      if (!storageExport) continue;
      exporters.push({
        installationId: installation.id,
        output,
        export: storageExport,
        official:
          installation.installConfigId === OFFICIAL_STORAGE_INSTALL_CONFIG_ID,
      });
    }

    if (exporters.length === 0) return undefined;
    const official = exporters.filter((candidate) => candidate.official);
    const candidates = official.length > 0 ? official : exporters;
    if (candidates.length !== 1) {
      // Fail closed: an impersonating same-workspace exporter (or two legit
      // installs) makes producer selection untrustworthy — mint nothing.
      this.#skip("ambiguous_storage_producer", {
        workspaceId,
        exporterCount: exporters.length,
        officialCount: official.length,
      });
      return undefined;
    }
    return candidates[0];
  }

  async #recordMintEvidence(input: {
    readonly phase: "plan" | "apply" | "destroy";
    readonly auditRunId: string;
    readonly workspaceId: string;
    readonly consumerInstallationId: string;
    readonly producerInstallationId: string;
    readonly expiresAt: string;
  }): Promise<void> {
    await this.#store.putCredentialMintEvent({
      id: this.#newId("credmint"),
      runId: input.auditRunId,
      workspaceId: input.workspaceId,
      capsuleId: input.consumerInstallationId,
      providerEnvId: input.producerInstallationId,
      phase: input.phase,
      capabilities: ["storage.object"],
      providerCredentialEvidence: [
        {
          providerEnvId: input.producerInstallationId,
          provider: "takos.storage",
          delivery: "generated_root_variable",
          rootOnly: false,
          temporary: true,
          ttlEnforced: true,
          expiresAt: input.expiresAt,
          secretValueStored: false,
          issuer: "takosumi_storage_scoped_token",
        },
      ],
      createdAt: new Date(this.#now()).toISOString(),
    });
  }

  #skip(reason: string, detail: Record<string, unknown>): void {
    this.#onSkip?.(reason, detail);
  }
}
