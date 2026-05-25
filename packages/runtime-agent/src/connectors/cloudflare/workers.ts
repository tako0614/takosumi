/**
 * `CloudflareWorkersConnector` — wraps `DirectCloudflareWorkersLifecycle`
 * for `worker@v1`.
 *
 * Reads the declared `entrypoint` from `ConnectorContext.source` and pushes
 * the bytes to Cloudflare's script upload endpoint.
 */

import type {
  JsonObject,
  LifecycleApplyRequest,
  LifecycleApplyResponse,
  LifecycleDescribeRequest,
  LifecycleDescribeResponse,
  LifecycleDestroyRequest,
  LifecycleDestroyResponse,
} from "takosumi-contract/reference/compat";
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

export interface CloudflareWorkersConnectorOptions {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
}

export class CloudflareWorkersConnector implements Connector {
  readonly provider = "@takos/cloudflare-workers";
  readonly shape = "worker@v1";
  readonly acceptedArtifactKinds: readonly string[] = [];
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
    if (!ctx.source) {
      throw new Error(
        "cloudflare-workers requires preparedSource to read worker entrypoint",
      );
    }
    const spec = parseWorkerSpec(req.spec);
    const bundle = await ctx.source.readFile(spec.entrypoint);
    const mainModule = pickMainModule(spec.entrypoint);
    const desc = await this.#lifecycle.putScript({
      scriptName: req.resourceName,
      bundle,
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

function pickMainModule(entrypoint: string): string {
  return entrypoint.split("/").at(-1) ?? entrypoint;
}

function outputsFor(desc: CloudflareWorkersDescriptor): JsonObject {
  return { url: desc.publicUrl, id: desc.scriptName };
}

function handleFor(desc: CloudflareWorkersDescriptor): string {
  return `${desc.accountId}/${desc.scriptName}`;
}

function scriptFromHandle(handle: string): string {
  return handle.split("/").at(-1) ?? handle;
}
