/**
 * `deno-deploy` provider for `worker@v1`.
 *
 * Provides Deno Deploy as a second provider for the `worker@v1` shape
 * alongside `cloudflare-workers`, satisfying the §5 portability invariant
 * (≥ 2 providers per reference shape). The thin shape-provider posts apply /
 * destroy / describe envelopes to a runtime-agent connector that drives the
 * Deno Deploy REST API; in-memory mode here is for local CLI runs and tests.
 *
 * v0 limitation: this plugin pins the assumption that the runtime-agent
 * connector creates one project per resource and uploads a single bundle
 * (`worker.js`) per deployment. Multi-asset bundles, KV namespaces, and the
 * organization-id flow are intentionally out of scope until the upstream
 * Deno Deploy API stabilises beyond `/v1/`.
 */

import type {
  ProviderPlugin,
  ResourceHandle,
} from "takosumi-contract/reference/provider-plugin";
import type {
  WorkerCapabilityTerm,
  WorkerOutputs,
  WorkerSpec,
} from "../../kinds/worker.ts";

export interface DenoDeployScriptDescriptor {
  readonly projectId: string;
  readonly deploymentId: string;
  readonly scriptName: string;
  readonly publicUrl: string;
}

export interface DenoDeployScriptCreateInput {
  readonly scriptName: string;
  readonly compatibilityDate?: string;
  readonly compatibilityFlags?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly routes?: readonly string[];
}

export interface DenoDeployLifecycleClient {
  putScript(
    input: DenoDeployScriptCreateInput,
  ): Promise<DenoDeployScriptDescriptor>;
  describeScript(input: {
    readonly scriptName: string;
  }): Promise<DenoDeployScriptDescriptor | undefined>;
  deleteScript(input: {
    readonly scriptName: string;
  }): Promise<boolean>;
}

export interface DenoDeployProviderOptions {
  readonly lifecycle: DenoDeployLifecycleClient;
  /** Deno Deploy organization id; only used by the runtime-agent wiring. */
  readonly organizationId?: string;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly WorkerCapabilityTerm[] = [
  "scale-to-zero",
  "long-request",
  "geo-routing",
];

export function createDenoDeployProvider(
  options: DenoDeployProviderOptions,
): ProviderPlugin<WorkerSpec, WorkerOutputs> {
  const lifecycle = options.lifecycle;
  const clock = options.clock ?? (() => new Date());
  void options.organizationId;

  return {
    id: "@takos/deno-deploy",
    version: "1.0.0",
    implements: { id: "worker", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const scriptName = scriptNameFromEntrypoint(spec);
      const runtime = workerRuntimeExtensions(spec);
      const desc = await lifecycle.putScript({
        scriptName,
        compatibilityDate: runtime.compatibilityDate,
        compatibilityFlags: runtime.compatibilityFlags,
        env: spec.env,
        // `routes` is no longer a formal worker-kind field (= dropped from
        // worker.jsonld). The materializer keeps reading `spec.routes` as
        // an implementation-level convention.
        routes: (spec as { routes?: readonly string[] }).routes,
      });
      return {
        handle: deployHandle(desc.projectId, desc.scriptName),
        outputs: outputsFromDescriptor(desc),
      };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteScript({
        scriptName: scriptNameFromHandle(handle),
      });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeScript({
        scriptName: scriptNameFromHandle(handle),
      });
      if (!desc) {
        return { kind: "deleted", observedAt: clock().toISOString() };
      }
      return {
        kind: "ready",
        outputs: outputsFromDescriptor(desc),
        observedAt: clock().toISOString(),
      };
    },
  };
}

function deployHandle(
  projectId: string,
  scriptName: string,
): ResourceHandle {
  return `deno:deploy:${projectId}:${scriptName}`;
}

function scriptNameFromHandle(handle: ResourceHandle): string {
  const parts = handle.split(":");
  return parts.at(-1) ?? handle;
}

function workerRuntimeExtensions(spec: WorkerSpec): {
  readonly compatibilityDate?: string;
  readonly compatibilityFlags?: readonly string[];
} {
  const compatibilityDate = typeof spec.compatibilityDate === "string"
    ? spec.compatibilityDate
    : undefined;
  const flags = spec.compatibilityFlags;
  const compatibilityFlags = Array.isArray(flags) &&
      flags.every((flag): flag is string => typeof flag === "string")
    ? flags
    : undefined;
  return { compatibilityDate, compatibilityFlags };
}

function scriptNameFromEntrypoint(spec: WorkerSpec): string {
  const token = spec.entrypoint
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return token.length > 0 ? `worker-${token}` : "worker";
}

function outputsFromDescriptor(
  desc: DenoDeployScriptDescriptor,
): WorkerOutputs {
  return {
    url: desc.publicUrl,
    id: desc.scriptName,
    version: desc.deploymentId,
  };
}

export class InMemoryDenoDeployLifecycle implements DenoDeployLifecycleClient {
  readonly #scripts = new Map<string, DenoDeployScriptDescriptor>();
  readonly #organizationId: string;
  #counter = 0;

  constructor(organizationId: string) {
    this.#organizationId = organizationId;
  }

  putScript(
    input: DenoDeployScriptCreateInput,
  ): Promise<DenoDeployScriptDescriptor> {
    this.#counter += 1;
    const desc: DenoDeployScriptDescriptor = {
      projectId: `proj_${this.#organizationId}_${input.scriptName}`,
      deploymentId: `dpl_${this.#counter.toString().padStart(8, "0")}`,
      scriptName: input.scriptName,
      publicUrl: `https://${input.scriptName}.deno.dev`,
    };
    this.#scripts.set(input.scriptName, desc);
    return Promise.resolve(desc);
  }

  describeScript(input: {
    readonly scriptName: string;
  }): Promise<DenoDeployScriptDescriptor | undefined> {
    return Promise.resolve(this.#scripts.get(input.scriptName));
  }

  deleteScript(input: {
    readonly scriptName: string;
  }): Promise<boolean> {
    return Promise.resolve(this.#scripts.delete(input.scriptName));
  }

  size(): number {
    return this.#scripts.size;
  }
}
