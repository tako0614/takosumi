import type { JsonValue } from "takosumi-contract";
import type { OutputSnapshot } from "takosumi-contract/output-snapshots";
import type {
  SensitiveOutputResolver,
  SensitiveOutputValue,
} from "../../core/domains/output-shares/mod.ts";
import type { SecretCryptoEnvLike } from "../../core/adapters/secret-store/memory.ts";
import type { R2Bucket } from "./bindings.ts";
import { StateArtifactCrypto } from "./state_crypto.ts";

export class R2SensitiveOutputResolver implements SensitiveOutputResolver {
  readonly #bucket: R2Bucket;
  readonly #crypto: StateArtifactCrypto;

  constructor(bucket: R2Bucket, crypto: StateArtifactCrypto) {
    this.#bucket = bucket;
    this.#crypto = crypto;
  }

  async resolve(input: {
    readonly outputSnapshot: OutputSnapshot;
    readonly outputName: string;
    readonly fromSpaceId: string;
    readonly toSpaceId: string;
    readonly producerInstallationId: string;
  }): Promise<SensitiveOutputValue | undefined> {
    const object = await this.#bucket.get(input.outputSnapshot.rawOutputArtifactKey);
    if (!object) return undefined;
    const ciphertext = new Uint8Array(await object.arrayBuffer());
    const plaintext = await this.#crypto.open(
      ciphertext,
      object.customMetadata?.["takosumi-content-digest"],
    );
    const envelope = parseRawOutputEnvelope(plaintext);
    const entry = envelope[input.outputName];
    if (!entry || entry.sensitive !== true) return undefined;
    return { value: entry.value, sensitive: true };
  }
}

export function sensitiveOutputResolverFromEnv(
  bucket: R2Bucket | undefined,
  cryptoEnv: SecretCryptoEnvLike,
): SensitiveOutputResolver | undefined {
  if (!bucket) return undefined;
  return new R2SensitiveOutputResolver(
    bucket,
    StateArtifactCrypto.fromEnv(cryptoEnv),
  );
}

function parseRawOutputEnvelope(
  plaintext: Uint8Array,
): Record<string, { readonly value: JsonValue; readonly sensitive: boolean }> {
  const decoded = new TextDecoder().decode(plaintext);
  const parsed = JSON.parse(decoded) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("raw output artifact must be a JSON object");
  }
  const result: Record<
    string,
    { readonly value: JsonValue; readonly sensitive: boolean }
  > = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (!isJsonValue(record.value)) continue;
    result[name] = {
      value: record.value,
      sensitive: record.sensitive === true,
    };
  }
  return result;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}
