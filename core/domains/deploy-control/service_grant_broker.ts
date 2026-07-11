/**
 * Scoped-token grant broker — the bind-time issuer behind a `storage.object`
 * (object store) or `source.git.smart_http` (git) consume.
 *
 * When a CONSUMER Capsule plans, for each scoped-token capability it consumes
 * this reads the current plan's allowlisted output projection (falling back to
 * the latest Output for updates), finds the
 * PRODUCER installation in the same workspace that publishes that capability
 * (fail-closed on ambiguity), decrypts the producer's sealed signing key,
 * mints a `tksvc_` scoped credential bounded to the consumer's prefix + verbs,
 * and returns the `TF_VAR_*` env to inject.
 *
 * The first plan exposes the declarative `consume`; the controller then mints a
 * grant and produces the final saved plan with that credential. There is no
 * post-apply or second-run activation lag.
 *
 * PRODUCER TRUST: installable Capsules are arbitrary Git, so producer selection
 * is based on the exported publication/capability surface and workspace
 * uniqueness. A lone exporter is accepted; multiple exporters fail CLOSED.
 *
 * A declared scoped consume is required and therefore fails closed when no
 * unique producer or signing authority can satisfy it. The returned env rides
 * the dispatch-only credential channel (never persisted or logged separately;
 * OpenTofu seals it inside the reviewed plan artifact).
 */

import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { JsonValue } from "../../../contract/types.ts";
import {
  mintServiceScopedCredential,
  type ServiceCredentialVerb,
} from "../../shared/service_scoped_credentials.ts";
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
  ) => readonly ServiceCredentialVerb[];
  /** TF_VAR env the grant injects into the consumer run. */
  readonly env: (grant: {
    url?: string;
    token: string;
    prefix: string;
    workspaceId: string;
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
    verbs: (binding) => serviceVerbsFromScopes(binding.grantRequest.scopes),
    env: (grant) => ({
      TF_VAR_object_storage_access_token: grant.token,
      TF_VAR_object_storage_key_prefix: grant.prefix,
      TF_VAR_object_storage_workspace_id: grant.workspaceId,
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
    consumerOutputs?: Readonly<Record<string, JsonValue>>,
  ): Promise<Record<string, string> | undefined> {
    if (phase !== "plan") return undefined;
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
      consumerOutputs,
    );
    if (consumerBindings.length === 0) return undefined;

    let env: Record<string, string> | undefined;
    for (const spec of GRANT_SPECS) {
      const specEnv = await this.#mintForSpec(
        spec,
        consumerBindings,
        { workspaceId, consumerInstallationId },
        phase,
        auditRunId,
      );
      if (specEnv) env = { ...(env ?? {}), ...specEnv };
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
    if (!producer) {
      throw new Error(
        `required service ${spec.publication} has no unique producer in this Workspace`,
      );
    }

    if (!this.#sensitiveOutputResolver) {
      throw new Error(
        `required service ${spec.publication} signing authority is unavailable`,
      );
    }
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
      throw new Error(
        `required service ${spec.publication} producer signing authority could not be resolved`,
      );
    }

    const prefix = spec.prefix(ctx.workspaceId, ctx.consumerInstallationId);
    if (!prefix) return undefined;
    const minted = await mintServiceScopedCredential({
      signingKey: signingKey.value,
      workspaceId: ctx.workspaceId,
      capsuleId: ctx.consumerInstallationId,
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
    });

    return spec.env({
      url: firstEndpointUrl(producer.export),
      token: minted.credential,
      prefix,
      workspaceId: ctx.workspaceId,
    });
  }

  async #consumerBindings(
    consumerInstallationId: string,
    consumerOutputs?: Readonly<Record<string, JsonValue>>,
  ): Promise<readonly ProjectedServiceBinding[]> {
    const outputs =
      consumerOutputs ??
      (await this.#store.getLatestOutputSnapshot(consumerInstallationId))
        ?.workspaceOutputs;
    if (!outputs) return [];
    return projectServicesFromOutputs(
      outputs as Readonly<Record<string, JsonValue>>,
      { allowExtensionCapabilities: true },
    ).serviceBindings;
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
      // Output is retained for audit after removal, but a retained snapshot is
      // not a live service. Stale Capsules still have an active deployment and
      // remain usable until their update is applied.
      if (installation.status !== "active" && installation.status !== "stale") {
        continue;
      }
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
          temporary: false,
          ttlEnforced: false,
          secretValueStored: false,
          issuer: "takosumi_service_scoped_credential",
        },
      ],
      createdAt: new Date(this.#now()).toISOString(),
    });
  }

  #skip(reason: string, detail: Record<string, unknown>): void {
    this.#onSkip?.(reason, detail);
  }
}

function serviceVerbsFromScopes(
  scopes: readonly string[],
): readonly ServiceCredentialVerb[] {
  const verbs = new Set<ServiceCredentialVerb>();
  for (const scope of scopes) {
    if (scope === "files:read") {
      verbs.add("r");
      verbs.add("l");
    } else if (scope === "files:write") {
      verbs.add("r");
      verbs.add("w");
      verbs.add("d");
      verbs.add("l");
    }
  }
  if (verbs.size === 0) {
    verbs.add("r");
    verbs.add("l");
  }
  return [...verbs];
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
