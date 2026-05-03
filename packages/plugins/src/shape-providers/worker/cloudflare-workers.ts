import type { ProviderPlugin, ResourceHandle } from "takosumi-contract";
import type {
  WorkerCapability,
  WorkerOutputs,
  WorkerSpec,
} from "../../shapes/worker.ts";

export interface CloudflareWorkersScriptDescriptor {
  readonly accountId: string;
  readonly scriptName: string;
  readonly publicUrl: string;
}

export interface CloudflareWorkersScriptCreateInput {
  readonly scriptName: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly routes?: readonly string[];
}

export interface CloudflareWorkersLifecycleClient {
  putScript(
    input: CloudflareWorkersScriptCreateInput,
  ): Promise<CloudflareWorkersScriptDescriptor>;
  describeScript(input: {
    readonly scriptName: string;
  }): Promise<CloudflareWorkersScriptDescriptor | undefined>;
  deleteScript(input: {
    readonly scriptName: string;
  }): Promise<boolean>;
}

export interface CloudflareWorkersProviderOptions {
  readonly lifecycle: CloudflareWorkersLifecycleClient;
  readonly accountId: string;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly WorkerCapability[] = [
  "scale-to-zero",
  "websocket",
  "long-request",
  "geo-routing",
  "crons",
];

export function createCloudflareWorkersProvider(
  options: CloudflareWorkersProviderOptions,
): ProviderPlugin<WorkerSpec, WorkerOutputs> {
  const lifecycle = options.lifecycle;
  const clock = options.clock ?? (() => new Date());
  // accountId is part of the option contract for parity with the runtime-agent
  // boot wiring; the descriptor returned by the lifecycle carries the
  // canonical id, so we do not reuse the option value during apply/status.
  void options.accountId;

  return {
    id: "cloudflare-workers",
    version: "1.0.0",
    implements: { id: "worker", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const scriptName = scriptNameFromArtifactHash(spec);
      const desc = await lifecycle.putScript({
        scriptName,
        compatibilityDate: spec.compatibilityDate,
        compatibilityFlags: spec.compatibilityFlags,
        env: spec.env,
        routes: spec.routes,
      });
      return {
        handle: workersHandle(desc.accountId, desc.scriptName),
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

function workersHandle(
  accountId: string,
  scriptName: string,
): ResourceHandle {
  return `cloudflare:workers:${accountId}:${scriptName}`;
}

function scriptNameFromHandle(handle: ResourceHandle): string {
  const parts = handle.split(":");
  return parts.at(-1) ?? handle;
}

function scriptNameFromArtifactHash(spec: WorkerSpec): string {
  const hash = spec.artifact.hash ?? "worker";
  // Strip `sha256:` etc. and use a kebab-cased token from the digest.
  const tail = hash.split(":").at(-1) ?? hash;
  const token = tail.toLowerCase().replace(/[^a-z0-9-]+/g, "").slice(0, 24);
  return token.length > 0 ? `worker-${token}` : "worker";
}

function outputsFromDescriptor(
  desc: CloudflareWorkersScriptDescriptor,
): WorkerOutputs {
  return {
    url: desc.publicUrl,
    scriptName: desc.scriptName,
  };
}

export class InMemoryCloudflareWorkersLifecycle
  implements CloudflareWorkersLifecycleClient {
  readonly #scripts = new Map<string, CloudflareWorkersScriptDescriptor>();
  readonly #accountId: string;

  constructor(accountId: string) {
    this.#accountId = accountId;
  }

  putScript(
    input: CloudflareWorkersScriptCreateInput,
  ): Promise<CloudflareWorkersScriptDescriptor> {
    const desc: CloudflareWorkersScriptDescriptor = {
      accountId: this.#accountId,
      scriptName: input.scriptName,
      publicUrl: `https://${input.scriptName}.${this.#accountId}.workers.dev`,
    };
    this.#scripts.set(input.scriptName, desc);
    return Promise.resolve(desc);
  }

  describeScript(input: {
    readonly scriptName: string;
  }): Promise<CloudflareWorkersScriptDescriptor | undefined> {
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
