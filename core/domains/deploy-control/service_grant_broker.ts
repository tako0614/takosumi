/**
 * Scoped-token grant broker — the bind-time issuer behind a `storage.object`
 * (object store) or `source.git.smart_http` (git) consume.
 *
 * When a CONSUMER installation runs, for each scoped-token capability it consumes
 * this: reads the consumer's LATEST OutputSnapshot service bindings, finds the
 * PRODUCER installation in the same workspace that publishes that capability
 * (fail-closed on ambiguity), decrypts the producer's sealed signing key,
 * mints a `takstor_` scoped token bounded to the consumer's own prefix + verbs,
 * and returns the `TF_VAR_*` env to inject.
 *
 * The consumer's `consume` is an OpenTofu OUTPUT, so it is read from the
 * consumer's previous OutputSnapshot; a grant activates on the run AFTER the
 * consume is first declared (the binding is optional/inert until injected).
 *
 * PRODUCER TRUST: installable Capsules are arbitrary Git, so producer selection
 * is based on the exported publication/capability surface and workspace
 * uniqueness. A lone exporter is accepted; multiple exporters fail CLOSED.
 *
 * FAIL-OPEN: never blocks a consumer apply — a decrypt failure, another app's
 * malformed output, or a store error yields "no grant". The returned env rides
 * the dispatch-only credential channel (never persisted, never logged).
 */

import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { JsonValue } from "../../../contract/types.ts";
import {
  mintStorageAccessToken,
  type StorageTokenVerb,
  storageVerbsFromScopes,
} from "../../shared/storage_access_tokens.ts";
import { projectServicesFromOutputs } from "../output-projection/service-projection.ts";
import type {
  ProjectedServiceBinding,
  ProjectedServiceExport,
} from "../output-projection/service-projection.ts";
import type { SensitiveOutputResolver } from "../output-shares/mod.ts";
import type { OpenTofuDeploymentStore } from "./store.ts";

/** One scoped-token capability the broker can mint grants for. */
interface GrantSpec {
  /** service_exports publication name to match producer + consumer binding. */
  readonly publication: string;
  /** Standard capability that also matches a consumer binding. */
  readonly capability: string;
  /** The producer's sealed OpenTofu output holding the HMAC signing key. */
  readonly signingKeyOutput: string;
  /** Token audience (the consuming service verifies it). */
  readonly audience: string;
  /** `provider` label recorded in the mint evidence. */
  readonly evidenceProvider: string;
  /** Key/repo prefix the minted token is confined to. */
  readonly prefix: (
    workspaceId: string,
    consumerInstallationId: string,
  ) => string;
  /** Verbs granted, derived from the consumer binding. */
  readonly verbs: (
    binding: ProjectedServiceBinding,
  ) => readonly StorageTokenVerb[];
  /** TF_VAR env the grant injects into the consumer run. */
  readonly env: (grant: {
    url?: string;
    token: string;
    prefix: string;
  }) => Record<string, string>;
}

const GRANT_SPECS: readonly GrantSpec[] = [
  {
    publication: "storage.object",
    capability: "storage.object",
    signingKeyOutput: "service_grant_signing_key",
    audience: "storage.object",
    evidenceProvider: "storage.object",
    prefix: (ws, inst) => `${ws}/${inst}/`,
    verbs: (binding) => storageVerbsFromScopes(binding.grantRequest.scopes),
    env: (grant) => ({
      TF_VAR_object_storage_access_token: grant.token,
      TF_VAR_object_storage_key_prefix: grant.prefix,
      ...(grant.url ? { TF_VAR_object_storage_api_url: grant.url } : {}),
    }),
  },
  {
    publication: "source.git.smart_http",
    capability: "source.git.smart_http",
    signingKeyOutput: "service_grant_signing_key",
    audience: "source.git.smart_http",
    evidenceProvider: "source.git.smart_http",
    // The consumer's repos live under its own installation id namespace.
    prefix: (_ws, inst) => inst,
    // Read-only clone/fetch for P1 (push is deferred).
    verbs: () => ["r"],
    env: (grant) => ({
      TF_VAR_git_access_token: grant.token,
      TF_VAR_git_repo_prefix: grant.prefix,
      ...(grant.url ? { TF_VAR_git_http_url: grant.url } : {}),
    }),
  },
];

type StoreOutputSnapshot = NonNullable<
  Awaited<ReturnType<OpenTofuDeploymentStore["getLatestOutputSnapshot"]>>
>;

interface ResolvedProducer {
  readonly installationId: string;
  readonly output: StoreOutputSnapshot;
  readonly export: ProjectedServiceExport;
}

export interface ServiceGrantBrokerDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId: (prefix: string) => string;
  readonly now: () => number;
  readonly sensitiveOutputResolver?: SensitiveOutputResolver;
  readonly onSkip?: (reason: string, detail: Record<string, unknown>) => void;
}

export class ServiceGrantBroker {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #sensitiveOutputResolver?: SensitiveOutputResolver;
  readonly #onSkip?: (reason: string, detail: Record<string, unknown>) => void;

  constructor(dependencies: ServiceGrantBrokerDependencies) {
    this.#store = dependencies.store;
    this.#newId = dependencies.newId;
    this.#now = dependencies.now;
    this.#sensitiveOutputResolver = dependencies.sensitiveOutputResolver;
    this.#onSkip = dependencies.onSkip;
  }

  /**
   * Returns the merged `TF_VAR_*` env for every scoped-token capability this
   * consumer run consumes, or `undefined` when it consumes none / nothing
   * resolves. Never throws (fail-open).
   */
  async mintServiceGrantEnv(
    planRun: PlanRun,
    phase: "plan" | "apply" | "destroy",
    auditRunId: string,
  ): Promise<Record<string, string> | undefined> {
    if (phase === "destroy") return undefined;
    const workspaceId = planRun.workspaceId ?? planRun.spaceId;
    const consumerInstallationId =
      planRun.installationContext?.installationId ?? planRun.installationId;
    if (!workspaceId || !consumerInstallationId) return undefined;
    // Prefixes are `/`-joined; a `/` in either id would blur scope boundaries.
    // Ids are server-generated (space_<hex> / inst_<hex>); guard defensively.
    if (workspaceId.includes("/") || consumerInstallationId.includes("/"))
      return undefined;

    const consumerBindings = await this.#consumerBindings(
      consumerInstallationId,
    );
    if (consumerBindings.length === 0) return undefined;

    let env: Record<string, string> | undefined;
    for (const spec of GRANT_SPECS) {
      try {
        const specEnv = await this.#mintForSpec(
          spec,
          consumerBindings,
          { workspaceId, consumerInstallationId },
          phase,
          auditRunId,
        );
        if (specEnv) env = { ...(env ?? {}), ...specEnv };
      } catch (error) {
        this.#skip("grant_resolution_error", {
          publication: spec.publication,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return env;
  }

  async #mintForSpec(
    spec: GrantSpec,
    consumerBindings: readonly ProjectedServiceBinding[],
    ctx: { workspaceId: string; consumerInstallationId: string },
    phase: "plan" | "apply" | "destroy",
    auditRunId: string,
  ): Promise<Record<string, string> | undefined> {
    const binding = consumerBindings.find((candidate) =>
      bindingMatches(candidate, spec),
    );
    if (!binding) return undefined;

    const producer = await this.#findProducer(
      spec,
      ctx.workspaceId,
      ctx.consumerInstallationId,
    );
    if (!producer) return undefined;

    if (!this.#sensitiveOutputResolver) return undefined;
    const signingKey = await this.#sensitiveOutputResolver.resolve({
      outputSnapshot: producer.output,
      outputName: spec.signingKeyOutput,
      fromSpaceId: ctx.workspaceId,
      toSpaceId: ctx.workspaceId,
      producerInstallationId: producer.installationId,
    });
    if (
      !signingKey ||
      typeof signingKey.value !== "string" ||
      signingKey.value.length === 0
    ) {
      this.#skip("producer_signing_key_unresolved", {
        publication: spec.publication,
        producerInstallationId: producer.installationId,
      });
      return undefined;
    }

    const prefix = spec.prefix(ctx.workspaceId, ctx.consumerInstallationId);
    if (!prefix) return undefined;
    const minted = await mintStorageAccessToken({
      signingKey: signingKey.value,
      workspaceId: ctx.workspaceId,
      installationId: ctx.consumerInstallationId,
      prefix,
      verbs: spec.verbs(binding),
      audience: spec.audience,
      now: this.#now,
    });

    await this.#recordMintEvidence(spec, {
      phase,
      auditRunId,
      workspaceId: ctx.workspaceId,
      consumerInstallationId: ctx.consumerInstallationId,
      producerInstallationId: producer.installationId,
      expiresAt: minted.expiresAt,
    });

    return spec.env({
      url: firstEndpointUrl(producer.export),
      token: minted.token,
      prefix,
    });
  }

  async #consumerBindings(
    consumerInstallationId: string,
  ): Promise<readonly ProjectedServiceBinding[]> {
    const output = await this.#store.getLatestOutputSnapshot(
      consumerInstallationId,
    );
    if (!output) return [];
    try {
      return projectServicesFromOutputs(
        output.workspaceOutputs as Readonly<Record<string, JsonValue>>,
        { allowExtensionCapabilities: true },
      ).serviceBindings;
    } catch {
      return [];
    }
  }

  async #findProducer(
    spec: GrantSpec,
    workspaceId: string,
    consumerInstallationId: string,
  ): Promise<ResolvedProducer | undefined> {
    const installations = await this.#store.listInstallations(workspaceId);
    const exporters: ResolvedProducer[] = [];
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
        continue;
      }
      const exp = serviceExports.find(
        (exported) => exported.name === spec.publication,
      );
      if (!exp) continue;
      exporters.push({
        installationId: installation.id,
        output,
        export: exp,
      });
    }
    if (exporters.length === 0) return undefined;
    if (exporters.length !== 1) {
      this.#skip("ambiguous_producer", {
        publication: spec.publication,
        exporterCount: exporters.length,
      });
      return undefined;
    }
    return exporters[0];
  }

  async #recordMintEvidence(
    spec: GrantSpec,
    input: {
      readonly phase: "plan" | "apply" | "destroy";
      readonly auditRunId: string;
      readonly workspaceId: string;
      readonly consumerInstallationId: string;
      readonly producerInstallationId: string;
      readonly expiresAt: string;
    },
  ): Promise<void> {
    await this.#store.putCredentialMintEvent({
      id: this.#newId("credmint"),
      runId: input.auditRunId,
      workspaceId: input.workspaceId,
      capsuleId: input.consumerInstallationId,
      providerEnvId: input.producerInstallationId,
      phase: input.phase,
      capabilities: [spec.capability],
      providerCredentialEvidence: [
        {
          providerEnvId: input.producerInstallationId,
          provider: spec.evidenceProvider,
          delivery: "generated_root_variable",
          rootOnly: false,
          temporary: true,
          ttlEnforced: true,
          expiresAt: input.expiresAt,
          secretValueStored: false,
          issuer: "takosumi_service_scoped_token",
        },
      ],
      createdAt: new Date(this.#now()).toISOString(),
    });
  }

  #skip(reason: string, detail: Record<string, unknown>): void {
    this.#onSkip?.(reason, detail);
  }
}

function bindingMatches(
  binding: ProjectedServiceBinding,
  spec: GrantSpec,
): boolean {
  return (
    binding.selector.name === spec.publication ||
    binding.selector.serviceExportId === spec.publication ||
    (binding.selector.capabilities as readonly string[]).includes(
      spec.capability,
    )
  );
}

function firstEndpointUrl(
  exportValue: ProjectedServiceExport,
): string | undefined {
  for (const endpoint of exportValue.endpoints ?? []) {
    if (typeof endpoint.url === "string" && endpoint.url.length > 0)
      return endpoint.url;
  }
  return undefined;
}
