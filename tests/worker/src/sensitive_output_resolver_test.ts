import { expect, test } from "bun:test";
import type {
  R2Bucket,
  R2ListOptions,
  R2Object,
  R2ObjectBody,
  R2Objects,
  R2PutOptions,
} from "../../../worker/src/bindings.ts";
import { StateArtifactCrypto } from "../../../worker/src/state_crypto.ts";
import { R2SensitiveOutputResolver } from "../../../worker/src/sensitive_output_resolver.ts";

const PASSPHRASE = "takosumi-sensitive-output-resolver-test-passphrase";
const RAW_KEY =
  "spaces/space_from/installations/inst_producer/runs/apply_1/outputs.raw.json.enc";

test("R2SensitiveOutputResolver returns only sensitive raw output values", async () => {
  const bucket = new FakeR2Bucket();
  const crypto = StateArtifactCrypto.fromEnv({
    TAKOSUMI_SECRET_STORE_PASSPHRASE: PASSPHRASE,
  });
  const plaintext = new TextEncoder().encode(JSON.stringify({
    admin_token: { sensitive: true, value: "super-secret-token" },
    public_url: { sensitive: false, value: "https://example.test" },
  }));
  const sealed = await crypto.seal(plaintext);
  await bucket.put(RAW_KEY, sealed.ciphertext, {
    customMetadata: {
      "takosumi-content-digest": sealed.contentDigest,
    },
  });
  const resolver = new R2SensitiveOutputResolver(bucket, crypto);
  const snapshot = {
    id: "out_1",
    spaceId: "space_from",
    installationId: "inst_producer",
    stateGeneration: 1,
    rawOutputArtifactKey: RAW_KEY,
    publicOutputs: {},
    spaceOutputs: { public_url: "https://example.test" },
    outputDigest: "sha256:test",
    createdAt: "2026-06-06T00:00:00.000Z",
  };

  await expect(resolver.resolve({
    outputSnapshot: snapshot,
    outputName: "admin_token",
    fromSpaceId: "space_from",
    toSpaceId: "space_to",
    producerInstallationId: "inst_producer",
  })).resolves.toEqual({
    value: "super-secret-token",
    sensitive: true,
  });
  await expect(resolver.resolve({
    outputSnapshot: snapshot,
    outputName: "public_url",
    fromSpaceId: "space_from",
    toSpaceId: "space_to",
    producerInstallationId: "inst_producer",
  })).resolves.toBeUndefined();
});

class FakeR2Bucket implements R2Bucket {
  readonly #objects = new Map<string, FakeR2ObjectBody>();

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    const bytes = await bytesFromR2PutValue(value);
    const object = new FakeR2ObjectBody(key, bytes, options);
    this.#objects.set(key, object);
    return object;
  }

  get(key: string): Promise<R2ObjectBody | null> {
    return Promise.resolve(this.#objects.get(key) ?? null);
  }

  head(key: string): Promise<R2Object | null> {
    return Promise.resolve(this.#objects.get(key) ?? null);
  }

  list(_options?: R2ListOptions): Promise<R2Objects> {
    return Promise.resolve({
      objects: Array.from(this.#objects.values()),
      truncated: false,
    });
  }

  delete(key: string): Promise<void> {
    this.#objects.delete(key);
    return Promise.resolve();
  }
}

class FakeR2ObjectBody implements R2ObjectBody {
  readonly size: number;
  readonly etag = "etag";
  readonly uploaded = new Date("2026-06-06T00:00:00.000Z");
  readonly httpMetadata?: { readonly contentType?: string };
  readonly customMetadata?: Record<string, string>;

  constructor(
    readonly key: string,
    readonly bytes: Uint8Array,
    options?: R2PutOptions,
  ) {
    this.size = bytes.byteLength;
    this.httpMetadata = options?.httpMetadata;
    this.customMetadata = options?.customMetadata;
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(
      this.bytes.buffer.slice(
        this.bytes.byteOffset,
        this.bytes.byteOffset + this.bytes.byteLength,
      ) as ArrayBuffer,
    );
  }
}

async function bytesFromR2PutValue(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
): Promise<Uint8Array> {
  if (value === null) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ReadableStream) {
    return new Uint8Array(await new Response(value).arrayBuffer());
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
