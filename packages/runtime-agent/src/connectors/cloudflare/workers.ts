/**
 * `CloudflareWorkersConnector` — wraps `DirectCloudflareWorkersLifecycle`
 * for `worker@v1`.
 *
 * Consumes uploaded `js-bundle` artifacts via `ConnectorContext.fetcher` and
 * pushes the bytes to Cloudflare's script upload endpoint. The kernel attaches
 * the artifact-store locator to every `LifecycleApplyRequest` for shapes
 * declaring `acceptedArtifactKinds: ["js-bundle"]`.
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
  type CloudflareWorkersDescriptor,
  DirectCloudflareWorkersLifecycle,
} from "./_workers_lifecycle.ts";

const DEFAULT_MAIN_MODULE = "worker.js";

export interface CloudflareWorkersConnectorOptions {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
}

export class CloudflareWorkersConnector implements Connector {
  readonly provider = "@takos/cloudflare-workers";
  readonly shape = "worker@v1";
  readonly acceptedArtifactKinds: readonly string[] = ["js-bundle"];
  readonly #lifecycle: DirectCloudflareWorkersLifecycle;

  constructor(opts: CloudflareWorkersConnectorOptions) {
    this.#lifecycle = new DirectCloudflareWorkersLifecycle({
      accountId: opts.accountId,
      apiToken: opts.apiToken,
      fetch: opts.fetch,
    });
  }

  async apply(
    req: LifecycleApplyRequest,
    ctx: ConnectorContext,
  ): Promise<LifecycleApplyResponse> {
    if (!ctx.fetcher) {
      throw new Error(
        "cloudflare-workers requires artifactStore to fetch js-bundle",
      );
    }
    const spec = parseWorkerSpec(req.spec);
    if (!spec.artifact?.hash) {
      throw new Error(
        "cloudflare-workers spec.artifact.hash is required for js-bundle",
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
    return deleted ? { ok: true } : { ok: true, note: "script not found" };
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
      const response = await this.#lifecycle.fetchSubdomainResponse();
      const text = response.ok ? "" : await response.text().catch(() => "");
      // 404 = subdomain not configured but credentials still proven valid.
      return verifyResultFromStatus(response.status, {
        okStatuses: [200, 404],
        responseText: text,
        context: "cf-workers:GetSubdomain",
      });
    } catch (error) {
      return verifyResultFromError(error, "cf-workers:GetSubdomain");
    }
  }
}

function pickMainModule(artifact: Artifact): string {
  const meta = artifact.metadata;
  if (meta && typeof meta === "object") {
    const entry = (meta as Record<string, unknown>).entrypoint;
    if (typeof entry === "string" && entry.length > 0) return entry;
  }
  return DEFAULT_MAIN_MODULE;
}

function outputsFor(desc: CloudflareWorkersDescriptor): JsonObject {
  return { url: desc.publicUrl, scriptName: desc.scriptName };
}

function handleFor(desc: CloudflareWorkersDescriptor): string {
  return `${desc.accountId}/${desc.scriptName}`;
}

function scriptFromHandle(handle: string): string {
  return handle.split("/").at(-1) ?? handle;
}
