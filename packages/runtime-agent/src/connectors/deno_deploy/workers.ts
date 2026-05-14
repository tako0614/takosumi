/**
 * `DenoDeployWorkersConnector` — wraps `DirectDenoDeployWorkersLifecycle`
 * for `worker@v1`.
 *
 * Consumes uploaded `js-bundle` artifacts via `ConnectorContext.fetcher` and
 * pushes the bytes to Deno Deploy's deployment endpoint. The kernel attaches
 * the artifact-store locator to every `LifecycleApplyRequest` for shapes
 * declaring `acceptedArtifactKinds: ["js-bundle"]`.
 *
 * v0 limitation: this connector treats the kernel-supplied `resourceName` as
 * the canonical Deno Deploy *project* name and creates one project per
 * resource. KV bindings, custom domains, and the multi-asset upload flow are
 * intentionally out of scope until upstream `/v1/` stabilises.
 */

import type {
  Artifact,
  JsonObject,
  LifecycleApplyRequest,
  LifecycleApplyResponse,
  LifecycleDescribeRequest,
  LifecycleDescribeResponse,
  LifecycleDestroyRequest,
  LifecycleDestroyResponse,
} from "takosumi-contract";
import type {
  Connector,
  ConnectorContext,
  ConnectorVerifyResult,
} from "../connector.ts";
import {
  verifyResultFromError,
  verifyResultFromStatus,
} from "../_verify_helpers.ts";
import { parseWorkerSpec } from "../_spec.ts";
import {
  type DenoDeployDescriptor,
  DirectDenoDeployWorkersLifecycle,
} from "./_workers_lifecycle.ts";

const DEFAULT_MAIN_MODULE = "worker.js";

export interface DenoDeployWorkersConnectorOptions {
  readonly accessToken: string;
  readonly organizationId?: string;
  readonly fetch?: typeof fetch;
}

export class DenoDeployWorkersConnector implements Connector {
  readonly provider = "@takos/deno-deploy";
  readonly shape = "worker@v1";
  readonly acceptedArtifactKinds: readonly string[] = ["js-bundle"];
  readonly #lifecycle: DirectDenoDeployWorkersLifecycle;

  constructor(opts: DenoDeployWorkersConnectorOptions) {
    this.#lifecycle = new DirectDenoDeployWorkersLifecycle({
      accessToken: opts.accessToken,
      organizationId: opts.organizationId,
      fetch: opts.fetch,
    });
  }

  async apply(
    req: LifecycleApplyRequest,
    ctx: ConnectorContext,
  ): Promise<LifecycleApplyResponse> {
    if (!ctx.fetcher) {
      throw new Error(
        "deno-deploy requires artifactStore to fetch js-bundle",
      );
    }
    const spec = parseWorkerSpec(req.spec);
    if (!spec.artifact?.hash) {
      throw new Error(
        "deno-deploy spec.artifact.hash is required for js-bundle",
      );
    }
    const fetched = await ctx.fetcher.fetch(spec.artifact.hash);
    const mainModule = pickMainModule(spec.artifact);
    const desc = await this.#lifecycle.putScript({
      scriptName: req.resourceName,
      bundle: fetched.bytes,
      compatibilityDate: spec.compatibilityDate,
      compatibilityFlags: spec.compatibilityFlags,
      env: spec.env,
      mainModule,
    });
    return {
      handle: handleFor(desc),
      outputs: outputsFor(desc),
    };
  }

  async destroy(
    req: LifecycleDestroyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDestroyResponse> {
    const deleted = await this.#lifecycle.deleteScript({
      scriptName: scriptFromHandle(req.handle),
    });
    return deleted ? { ok: true } : { ok: true, note: "project not found" };
  }

  async describe(
    req: LifecycleDescribeRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDescribeResponse> {
    const desc = await this.#lifecycle.describeScript({
      scriptName: scriptFromHandle(req.handle),
    });
    if (!desc) return { status: "missing" };
    return { status: "running", outputs: outputsFor(desc) };
  }

  async verify(_ctx: ConnectorContext): Promise<ConnectorVerifyResult> {
    try {
      const response = await this.#lifecycle.listProjectsResponse();
      const text = response.ok ? "" : await response.text().catch(() => "");
      return verifyResultFromStatus(response.status, {
        okStatuses: [200],
        responseText: text,
        context: "deno-deploy:ListProjects",
      });
    } catch (error) {
      return verifyResultFromError(error, "deno-deploy:ListProjects");
    }
  }
}

function pickMainModule(artifact: Artifact): string {
  const entry = artifact.metadata?.entrypoint;
  if (typeof entry === "string" && entry.length > 0) return entry;
  return DEFAULT_MAIN_MODULE;
}

function outputsFor(desc: DenoDeployDescriptor): JsonObject {
  return {
    url: desc.publicUrl,
    scriptName: desc.scriptName,
    version: desc.deploymentId,
  };
}

function handleFor(desc: DenoDeployDescriptor): string {
  return `${desc.organizationId}/${desc.scriptName}`;
}

function scriptFromHandle(handle: string): string {
  return handle.split("/").at(-1) ?? handle;
}
