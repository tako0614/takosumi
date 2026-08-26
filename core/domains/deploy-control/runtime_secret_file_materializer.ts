import type {
  InstallConfigRuntimeBindingMaterialization,
  RuntimeSecretFileMaterialization,
} from "takosumi-contract/install-configs";
import type { SecretBoundaryCrypto } from "../../adapters/secret-store/memory.ts";
import type { SecretPartition } from "../../adapters/secret-store/types.ts";
import {
  stableJsonDigest,
  stableStringify,
} from "../../adapters/source/digest.ts";
import type {
  OpenTofuControlStore,
  StoredSecretBlob,
} from "./store.ts";

export const RUNTIME_SECRET_FILE_BUNDLE_MARKER =
  "[runtime-secret-file-bundle]" as const;

const PROFILE_CONTRACT = "takosumi.runtime-binding-profile/v1";
const FILE_CONTRACT = "takosumi.runtime-secret-file/v1";
const RUNNER_CONTRACT = "takosumi.runner-runtime-secret-files/v1";
const BLOB_SCHEME = "runtime-secret-file-aes-gcm/v1";
const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const ENV_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RESERVED_ENV_PATTERN = /^(?:BUN_|DYLD_|GIT_|LD_|NODE_|NPM_|OPENTOFU_|TAKOSUMI_|TF_)/u;
const RESERVED_ENV_NAMES = new Set([
  "HOME",
  "HOSTNAME",
  "PATH",
  "PWD",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
]);

export interface RunnerRuntimeSecretFile {
  readonly path: string;
  readonly mode: 384;
  readonly content: string;
  readonly envName: string;
  readonly secretNames: readonly string[];
}

export interface RunnerRuntimeSecretFilesDispatch {
  readonly contract: typeof RUNNER_CONTRACT;
  readonly profileDigest: `sha256:${string}`;
  readonly files: readonly [RunnerRuntimeSecretFile];
}

/**
 * Opaque control-plane carrier. JSON/string/inspection collapse to a marker;
 * only the runner adapter calls the explicit dispatch method.
 */
export class RuntimeSecretFileBundle {
  readonly #dispatch: RunnerRuntimeSecretFilesDispatch;

  constructor(dispatch: RunnerRuntimeSecretFilesDispatch) {
    this.#dispatch = dispatch;
  }

  toRunnerDispatch(): RunnerRuntimeSecretFilesDispatch {
    const file = this.#dispatch.files[0];
    return {
      contract: RUNNER_CONTRACT,
      profileDigest: this.#dispatch.profileDigest,
      files: [
        {
          ...file,
          secretNames: [...file.secretNames],
        },
      ],
    };
  }

  toJSON(): typeof RUNTIME_SECRET_FILE_BUNDLE_MARKER {
    return RUNTIME_SECRET_FILE_BUNDLE_MARKER;
  }

  toString(): typeof RUNTIME_SECRET_FILE_BUNDLE_MARKER {
    return RUNTIME_SECRET_FILE_BUNDLE_MARKER;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): typeof RUNTIME_SECRET_FILE_BUNDLE_MARKER {
    return RUNTIME_SECRET_FILE_BUNDLE_MARKER;
  }
}

export interface RuntimeSecretFileMaterializer {
  materialize(input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly installConfigId: string;
    readonly phase: "post_apply";
  }): Promise<RuntimeSecretFileBundle>;
  retire(input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly installConfigId: string;
    readonly profileDigest: string;
  }): Promise<void>;
}

export function createRuntimeSecretFileMaterializer(input: {
  readonly store: OpenTofuControlStore;
  readonly crypto: SecretBoundaryCrypto;
  readonly clock?: () => Date;
}): RuntimeSecretFileMaterializer {
  const clock = input.clock ?? (() => new Date());
  return {
    async materialize(request) {
      if (request.phase !== "post_apply") {
        invalid("runtime secret files are available only for post_apply");
      }
      const current = await currentProfile(input.store, request);
      if (current.capsule.status === "destroyed") {
        invalid("runtime secret file Capsule is destroyed");
      }
      const profileDigest = (await stableJsonDigest(
        current.file,
      )) as `sha256:${string}`;
      const ownerRef = runtimeSecretFileOwnerRef(request.capsuleId);
      const partition = runtimeSecretFilePartition(request.capsuleId);
      const aad = runtimeSecretFileAad({
        ownerRef,
        workspaceId: request.workspaceId,
        capsuleId: request.capsuleId,
        profileDigest,
      });
      let blob = await input.store.getSecretBlob(ownerRef);
      if (!blob) {
        const content = await generateRuntimeSecretFile(current.file);
        const sealed = await input.crypto.seal(
          content,
          partition,
          new TextEncoder().encode(aad),
        );
        const createdAt = exactClock(clock());
        const candidate = runtimeSecretFileBlob({
          ownerRef,
          workspaceId: request.workspaceId,
          partition,
          aad,
          sealed,
          createdAt,
          crypto: input.crypto,
        });
        if (await input.store.createSecretBlobIfAbsent(candidate)) {
          blob = candidate;
        } else {
          blob = await input.store.getSecretBlob(ownerRef);
        }
      }
      if (!blob) invalid("runtime secret file storage acknowledgement was lost");
      const content = await openRuntimeSecretFile({
        blob,
        ownerRef,
        workspaceId: request.workspaceId,
        partition,
        aad,
        crypto: input.crypto,
      });
      const values = exactRuntimeSecretValues(content, current.file);
      return new RuntimeSecretFileBundle({
        contract: RUNNER_CONTRACT,
        profileDigest,
        files: [
          {
            path: current.file.fileName,
            mode: 0o600,
            content: `${stableStringify(values)}\n`,
            envName: current.file.envName,
            secretNames: Object.keys(values).sort(),
          },
        ],
      });
    },
    async retire(request) {
      const current = await currentProfile(input.store, request);
      if (current.capsule.status !== "destroyed") {
        invalid("runtime secret file retires only after Capsule is destroyed");
      }
      const profileDigest = await stableJsonDigest(current.file);
      if (request.profileDigest !== profileDigest) {
        invalid("runtime secret file retirement profile is stale");
      }
      const ownerRef = runtimeSecretFileOwnerRef(request.capsuleId);
      const partition = runtimeSecretFilePartition(request.capsuleId);
      const aad = runtimeSecretFileAad({
        ownerRef,
        workspaceId: request.workspaceId,
        capsuleId: request.capsuleId,
        profileDigest,
      });
      const blob = await input.store.getSecretBlob(ownerRef);
      if (!blob) return;
      assertRuntimeSecretFileBlob({
        blob,
        ownerRef,
        workspaceId: request.workspaceId,
        partition,
        aad,
      });
      await input.store.deleteSecretBlob(ownerRef);
    },
  };
}

async function currentProfile(
  store: OpenTofuControlStore,
  request: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly installConfigId: string;
  },
) {
  const capsule = await store.getCapsule(request.capsuleId);
  if (
    !capsule ||
    capsule.workspaceId !== request.workspaceId ||
    capsule.installConfigId !== request.installConfigId
  ) {
    invalid("runtime secret file Capsule authority is not current");
  }
  const config = await store.getInstallConfig(request.installConfigId);
  if (
    !config ||
    config.id !== capsule.installConfigId ||
    (config.workspaceId !== undefined &&
      config.workspaceId !== request.workspaceId)
  ) {
    invalid("runtime secret file InstallConfig authority is not current");
  }
  return {
    capsule,
    file: exactRuntimeSecretFileProfile(config.runtimeBindingMaterialization),
  };
}

function exactRuntimeSecretFileProfile(
  profile: InstallConfigRuntimeBindingMaterialization | undefined,
): RuntimeSecretFileMaterialization {
  if (!isRecord(profile) || profile.contract !== PROFILE_CONTRACT) {
    invalid("runtime secret file profile is missing");
  }
  const file = profile.runtimeSecretFile;
  if (!isRecord(file) || file.contract !== FILE_CONTRACT) {
    invalid("runtime secret file profile is missing");
  }
  if (
    typeof file.envName !== "string" ||
    !ENV_PATTERN.test(file.envName) ||
    RESERVED_ENV_NAMES.has(file.envName) ||
    RESERVED_ENV_PATTERN.test(file.envName)
  ) {
    invalid("runtime secret file env name is unsafe");
  }
  if (typeof file.fileName !== "string" || !FILE_PATTERN.test(file.fileName)) {
    invalid("runtime secret file name is unsafe");
  }
  if (file.mode !== 0o600 || !Array.isArray(file.values)) {
    invalid("runtime secret file mode or values are invalid");
  }
  if (file.values.length < 1 || file.values.length > 16) {
    invalid("runtime secret file value count is invalid");
  }
  const names: string[] = [];
  for (const value of file.values) {
    if (!isRecord(value)) invalid("runtime secret file value is invalid");
    if (value.kind === "random") {
      exactSecretName(value.name);
      if (
        typeof value.bytes !== "number" ||
        !Number.isInteger(value.bytes) ||
        value.bytes < 16 ||
        value.bytes > 64 ||
        (value.encoding !== "hex" && value.encoding !== "base64")
      ) {
        invalid("runtime random secret declaration is invalid");
      }
      names.push(value.name);
      continue;
    }
    if (value.kind === "rsa-key-pair") {
      exactSecretName(value.privateName);
      exactSecretName(value.publicName);
      if (value.modulusLength !== 2048 || value.hash !== "SHA-256") {
        invalid("runtime RSA key declaration is invalid");
      }
      names.push(value.privateName, value.publicName);
      continue;
    }
    invalid("runtime secret file generator is unsupported");
  }
  if (new Set(names).size !== names.length) {
    invalid("runtime secret file names must be unique");
  }
  return file as RuntimeSecretFileMaterialization;
}

async function generateRuntimeSecretFile(
  profile: RuntimeSecretFileMaterialization,
): Promise<string> {
  const values: Record<string, string> = {};
  for (const declaration of profile.values) {
    if (declaration.kind === "random") {
      const bytes = new Uint8Array(declaration.bytes);
      crypto.getRandomValues(bytes);
      values[declaration.name] =
        declaration.encoding === "hex" ? bytesToHex(bytes) : bytesToBase64(bytes);
      continue;
    }
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: declaration.modulusLength,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: declaration.hash,
      },
      true,
      ["sign", "verify"],
    );
    const privateDer = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    );
    const publicDer = new Uint8Array(
      await crypto.subtle.exportKey("spki", pair.publicKey),
    );
    values[declaration.privateName] = pem("PRIVATE KEY", privateDer);
    values[declaration.publicName] = pem("PUBLIC KEY", publicDer);
  }
  return stableStringify(values);
}

function exactRuntimeSecretValues(
  content: string,
  profile: RuntimeSecretFileMaterialization,
): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    invalid("sealed runtime secret file is invalid");
  }
  if (!isRecord(parsed)) invalid("sealed runtime secret file is invalid");
  const declared = profile.values.flatMap((value) =>
    value.kind === "random"
      ? [value.name]
      : [value.privateName, value.publicName],
  ).sort();
  const actual = Object.keys(parsed).sort();
  if (
    actual.length !== declared.length ||
    actual.some((name, index) => name !== declared[index]) ||
    actual.some((name) => typeof parsed[name] !== "string" || parsed[name] === "")
  ) {
    invalid("sealed runtime secret file differs from its profile");
  }
  return Object.fromEntries(actual.map((name) => [name, parsed[name] as string]));
}

async function openRuntimeSecretFile(input: {
  readonly blob: StoredSecretBlob;
  readonly ownerRef: string;
  readonly workspaceId: string;
  readonly partition: SecretPartition;
  readonly aad: string;
  readonly crypto: SecretBoundaryCrypto;
}): Promise<string> {
  assertRuntimeSecretFileBlob(input);
  try {
    return await input.crypto.open(
      base64ToBytes(input.blob.ciphertext),
      input.partition,
      new TextEncoder().encode(input.aad),
    );
  } catch {
    invalid("sealed runtime secret file could not be opened");
  }
}

function assertRuntimeSecretFileBlob(input: {
  readonly blob: StoredSecretBlob;
  readonly ownerRef: string;
  readonly workspaceId: string;
  readonly partition: SecretPartition;
  readonly aad: string;
}): void {
  if (
    input.blob.connectionId !== input.ownerRef ||
    input.blob.workspaceId !== input.workspaceId ||
    input.blob.kind !== input.partition ||
    input.blob.encryptedDek !== `${BLOB_SCHEME}/${input.partition}` ||
    input.blob.aad !== input.aad
  ) {
    invalid("runtime secret file profile or owner fence changed");
  }
}

function runtimeSecretFileBlob(input: {
  readonly ownerRef: string;
  readonly workspaceId: string;
  readonly partition: SecretPartition;
  readonly aad: string;
  readonly sealed: Uint8Array;
  readonly createdAt: string;
  readonly crypto: SecretBoundaryCrypto;
}): StoredSecretBlob {
  return {
    id: `secret_${input.ownerRef}`,
    connectionId: input.ownerRef,
    workspaceId: input.workspaceId,
    kind: input.partition,
    ciphertext: bytesToBase64(input.sealed),
    encryptedDek: `${BLOB_SCHEME}/${input.partition}`,
    nonce: bytesToBase64(input.sealed.slice(0, 12)),
    aad: input.aad,
    keyVersion: input.crypto.keyVersion?.(input.partition) ?? 1,
    createdAt: input.createdAt,
  };
}

function runtimeSecretFileAad(input: {
  readonly ownerRef: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly profileDigest: string;
}): string {
  return stableStringify({
    contract: FILE_CONTRACT,
    ownerRef: input.ownerRef,
    workspaceId: input.workspaceId,
    capsuleId: input.capsuleId,
    profileDigest: input.profileDigest,
  });
}

function runtimeSecretFileOwnerRef(capsuleId: string): string {
  exactIdentifier(capsuleId, "capsuleId");
  return `runtime_secret_file_${capsuleId}`;
}

function runtimeSecretFilePartition(capsuleId: string): SecretPartition {
  exactIdentifier(capsuleId, "capsuleId");
  return `runtime-secret-file:${capsuleId}`;
}

function exactIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    invalid(`runtime secret file ${label} is invalid`);
  }
}

function exactSecretName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !NAME_PATTERN.test(value)) {
    invalid("runtime secret file value name is invalid");
  }
}

function exactClock(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    invalid("runtime secret file clock is invalid");
  }
  return value.toISOString();
}

function pem(label: string, bytes: Uint8Array): string {
  const base64 = bytesToBase64(bytes);
  const lines = base64.match(/.{1,64}/gu) ?? [];
  return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`].join(
    "\n",
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new TypeError(message);
}
