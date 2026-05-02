/**
 * `FilesystemConnector` — selfhost object-store backed by a local directory.
 *
 * Maps `bucketName` to a directory under `rootDir` using `Deno.mkdir` /
 * `Deno.remove`. Used for development and air-gapped / single-node deploys.
 */

import type {
  JsonObject,
  LifecycleApplyRequest,
  LifecycleApplyResponse,
  LifecycleDescribeRequest,
  LifecycleDescribeResponse,
  LifecycleDestroyRequest,
  LifecycleDestroyResponse,
} from "takosumi-contract";
import type { Connector } from "../connector.ts";

export interface FilesystemConnectorOptions {
  readonly rootDir: string;
  readonly secretRefBase?: string;
}

export class FilesystemConnector implements Connector {
  readonly provider = "filesystem";
  readonly shape = "object-store@v1";
  readonly #rootDir: string;
  readonly #secretBase: string;

  constructor(opts: FilesystemConnectorOptions) {
    this.#rootDir = opts.rootDir;
    this.#secretBase = opts.secretRefBase ?? `secret://selfhosted/object-store`;
  }

  async apply(req: LifecycleApplyRequest): Promise<LifecycleApplyResponse> {
    const spec = req.spec as unknown as { name: string };
    const path = `${this.#rootDir}/${spec.name}`;
    await Deno.mkdir(path, { recursive: true });
    return {
      handle: path,
      outputs: this.#outputsFor(spec.name, path),
    };
  }

  async destroy(
    req: LifecycleDestroyRequest,
  ): Promise<LifecycleDestroyResponse> {
    try {
      await Deno.remove(req.handle, { recursive: true });
      return { ok: true };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { ok: true, note: "directory not found" };
      }
      throw error;
    }
  }

  async describe(
    req: LifecycleDescribeRequest,
  ): Promise<LifecycleDescribeResponse> {
    try {
      const stat = await Deno.stat(req.handle);
      if (!stat.isDirectory) return { status: "missing" };
      const bucket = bucketFromPath(req.handle, this.#rootDir);
      return {
        status: "running",
        outputs: this.#outputsFor(bucket, req.handle),
      };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { status: "missing" };
      }
      throw error;
    }
  }

  #outputsFor(bucket: string, path: string): JsonObject {
    return {
      bucket,
      endpoint: `file://${path}`,
      region: "local",
      accessKeyRef: `${this.#secretBase}/access-key`,
      secretKeyRef: `${this.#secretBase}/secret-key`,
    };
  }
}

function bucketFromPath(handle: string, rootDir: string): string {
  const stripped = handle.startsWith(`${rootDir}/`)
    ? handle.slice(rootDir.length + 1)
    : handle;
  const slash = stripped.indexOf("/");
  return slash >= 0 ? stripped.slice(0, slash) : stripped;
}
