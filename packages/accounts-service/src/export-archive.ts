// @runtime server-only
//
// This module shells out to `tar` and `age` and writes to a temp
// directory. It runs only on long-lived server runtimes (Bun or Node
// on a VM / container) — it is NOT importable from Cloudflare Workers
// or any other edge runtime. Workers entry points keep the export
// metadata path and let the operator wire a substrate-appropriate
// archive worker (e.g. R2 object PUT) instead.
//
// REQUIRES A WRITABLE WORKING DIRECTORY. `writeInstallationExportTarZst`
// creates a temp dir and the metadata-only worker `mkdir`s
// `options.outputDirectory`; both must be writable (e.g. a tmpfs scratch
// mount), so this module does not run on a fully read-only container
// root. For age-encrypted exports the FULL cleartext `takos-export.tar.zst`
// is written to the temp dir first and only then encrypted, so the temp dir
// must be on storage acceptable for transient unencrypted tenant data and is
// always removed in the `finally` block. A read-only or non-writable path
// makes the mkdir/write throw, which surfaces as a failed export (fail-closed)
// rather than a partial or silently-succeeding one.
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AccountsInstallationExportBundle } from "./export-bundle.ts";
import { sha256HexBytes } from "./installation-helpers.ts";
import type {
  AppInstallationExportWorker,
  AppInstallationExportWorkerInput,
} from "./mod.ts";
import { readEnvVar } from "./read-env.ts";

const archiveRoot = "takos-export";
const dataRoot = `${archiveRoot}/data`;
const dataManifestKind =
  "takosumi.accounts.installation-export-data-manifest@v1";

export interface InstallationExportArchiveFile {
  readonly path: string;
  readonly content: string | Uint8Array;
}

export interface InstallationExportArchiveDataFile {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly mediaType?: string;
}

export interface WriteInstallationExportArchiveInput {
  readonly bundle: AccountsInstallationExportBundle;
  readonly outputPath: string;
  readonly dataFiles?: readonly InstallationExportArchiveDataFile[];
  readonly artifactDescriptorContent?: string;
  readonly encryption?: InstallationExportArchiveEncryption;
  readonly tarExecutable?: string;
  readonly zstdExecutable?: string;
  readonly ageExecutable?: string;
}

export interface InstallationExportArchiveEncryption {
  readonly method: "none" | "age";
  readonly recipients?: readonly string[];
}

export interface MetadataOnlyInstallationExportWorkerOptions {
  readonly outputDirectory: string;
  readonly downloadBaseUrl?: string;
  readonly uploader?: InstallationExportArchiveUploader;
  readonly dataProvider?: InstallationExportDataProvider;
  readonly artifactDescriptorProvider?:
    InstallationExportArtifactDescriptorProvider;
  readonly objectKeyPrefix?: string;
  readonly ttlMs?: number;
  readonly tarExecutable?: string;
  readonly zstdExecutable?: string;
  readonly ageExecutable?: string;
  readonly now?: () => Date;
}

export interface InstallationExportArchiveUploadInput {
  readonly filePath: string;
  readonly objectKey: string;
  readonly contentType: string;
  readonly contentEncoding?: string;
  readonly downloadExpiresAt: string;
  readonly metadata: Record<string, string>;
}

export interface InstallationExportArchiveUploadResult {
  readonly downloadUrl: string;
  readonly downloadExpiresAt: string;
}

export type InstallationExportArchiveUploader = (
  input: InstallationExportArchiveUploadInput,
) =>
  | InstallationExportArchiveUploadResult
  | Promise<InstallationExportArchiveUploadResult>;

export type InstallationExportDataProvider = (
  input: AppInstallationExportWorkerInput,
) =>
  | readonly InstallationExportArchiveDataFile[]
  | Promise<readonly InstallationExportArchiveDataFile[]>;

export type InstallationExportArtifactDescriptorProvider = (
  input: AppInstallationExportWorkerInput,
) => string | undefined | Promise<string | undefined>;

export interface BuildInstallationExportArchiveFilesOptions {
  readonly artifactDescriptorContent?: string;
}

export async function buildInstallationExportArchiveFiles(
  bundle: AccountsInstallationExportBundle,
  dataFiles: readonly InstallationExportArchiveDataFile[] = [],
  options: BuildInstallationExportArchiveFilesOptions = {},
): Promise<readonly InstallationExportArchiveFile[]> {
  const normalizedDataFiles = await normalizeDataFiles(dataFiles);
  return [
    {
      path: `${archiveRoot}/bundle.json`,
      content: `${JSON.stringify(bundle, null, 2)}\n`,
    },
    {
      path: `${archiveRoot}/installation.json`,
      content: `${JSON.stringify(installationProjection(bundle), null, 2)}\n`,
    },
    {
      path: `${archiveRoot}/source.json`,
      content: `${JSON.stringify(bundle.source, null, 2)}\n`,
    },
    {
      path: `${archiveRoot}/artifact.yml`,
      content: artifactDescriptorArchiveContent(bundle, options),
    },
    ...dataArchiveFiles(normalizedDataFiles),
    {
      path: `${archiveRoot}/use-edges/template.yml`,
      content: jsonYaml({
        use_edges: bundle.useEdges.map((useEdge) => ({
          name: useEdge.name,
          kind: useEdge.kind,
          configRef: useEdge.template.configRef,
          secretRefs: useEdge.template.secretRefs,
        })),
      }),
    },
    {
      path: `${archiveRoot}/oidc/use-edge-template.json`,
      content: `${JSON.stringify(oidcUseEdgeTemplate(bundle), null, 2)}\n`,
    },
    {
      path: `${archiveRoot}/docs/restore.md`,
      content: restoreGuide(bundle),
    },
  ];
}

export async function writeInstallationExportTarZst(
  input: WriteInstallationExportArchiveInput,
): Promise<void> {
  const encryption = normalizeArchiveEncryption(input.encryption);
  const tempRoot = await mkdtemp(join(tmpdir(), "takosumi-accounts-export-"));
  try {
    await materializeArchiveTree({
      root: tempRoot,
      files: await buildInstallationExportArchiveFiles(
        input.bundle,
        input.dataFiles ?? [],
        { artifactDescriptorContent: input.artifactDescriptorContent },
      ),
    });
    const clearArchivePath = encryption.method === "age"
      ? join(tempRoot, "takos-export.tar.zst")
      : input.outputPath;
    const output = await commandOutput(input.tarExecutable ?? "tar", [
        `--use-compress-program=${input.zstdExecutable ?? "zstd"}`,
        "-cf",
        clearArchivePath,
        "-C",
        tempRoot,
        archiveRoot,
      ]);
    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr).trim();
      throw new Error(
        `failed to write installation export archive${
          stderr ? `: ${stderr}` : ""
        }`,
      );
    }
    if (encryption.method === "age") {
      const ageOutput = await commandOutput(input.ageExecutable ?? "age", [
          ...encryption.recipients.flatMap((recipient) => ["-r", recipient]),
          "-o",
          input.outputPath,
          clearArchivePath,
        ]);
      if (!ageOutput.success) {
        const stderr = new TextDecoder().decode(ageOutput.stderr).trim();
        throw new Error(
          `failed to encrypt installation export archive${
            stderr ? `: ${stderr}` : ""
          }`,
        );
      }
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export function createMetadataOnlyInstallationExportWorker(
  options: MetadataOnlyInstallationExportWorkerOptions,
): AppInstallationExportWorker {
  const uploader = options.uploader ??
    createHttpDirectoryInstallationExportArchiveUploader({
      downloadBaseUrl: requiredDownloadBaseUrl(options.downloadBaseUrl),
      outputDirectory: options.outputDirectory,
    });
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  return async (input) => {
    await mkdir(options.outputDirectory, { recursive: true });
    const encrypted = input.request.encryption.method === "age";
    const fileName = `takos-export-${input.operationId}.tar.zst${
      encrypted ? ".age" : ""
    }`;
    const objectKey = prefixedObjectKey(options.objectKeyPrefix, fileName);
    const outputPath = join(options.outputDirectory, fileName);
    const dataFiles = input.request.includeData && options.dataProvider
      ? await options.dataProvider(input)
      : [];
    const artifactDescriptorContent = options.artifactDescriptorProvider
      ? await options.artifactDescriptorProvider(input)
      : undefined;
    await writeInstallationExportTarZst({
      bundle: input.bundle,
      outputPath,
      dataFiles,
      artifactDescriptorContent,
      encryption: input.request.encryption,
      tarExecutable: options.tarExecutable,
      zstdExecutable: options.zstdExecutable,
      ageExecutable: options.ageExecutable,
    });
    const now = options.now?.() ?? new Date();
    const downloadExpiresAt = new Date(now.getTime() + ttlMs).toISOString();
    return await uploader({
      filePath: outputPath,
      objectKey,
      contentType: "application/zstd",
      contentEncoding: encrypted ? "age" : undefined,
      downloadExpiresAt,
      metadata: {
        installationId: input.installation.installationId,
        accountId: input.installation.accountId,
        spaceId: input.installation.spaceId,
        operationId: input.operationId,
        format: input.request.format,
        encryption: input.request.encryption.method,
        dataIncluded: dataFiles.length > 0 ? "true" : "false",
        artifactDescriptorIncluded: artifactDescriptorContent !== undefined
          ? "true"
          : "false",
      },
    });
  };
}

export function createHttpDirectoryInstallationExportArchiveUploader(options: {
  readonly downloadBaseUrl: string;
  readonly outputDirectory?: string;
}): InstallationExportArchiveUploader {
  const downloadBaseUrl = normalizedHttpDirectoryUrl(options.downloadBaseUrl);
  return async (input) => {
    if (options.outputDirectory) {
      const targetPath = join(options.outputDirectory, input.objectKey);
      if (targetPath !== input.filePath) {
        await mkdir(dirname(targetPath), { recursive: true });
        await copyFile(input.filePath, targetPath);
      }
    }
    return {
      downloadUrl: new URL(input.objectKey, downloadBaseUrl).toString(),
      downloadExpiresAt: input.downloadExpiresAt,
    };
  };
}

function normalizeArchiveEncryption(
  value: InstallationExportArchiveEncryption | undefined,
): { method: "none" } | { method: "age"; recipients: readonly string[] } {
  if (!value || value.method === "none") return { method: "none" };
  const recipients = value.recipients ?? [];
  if (recipients.length === 0) {
    throw new TypeError(
      "age export encryption requires at least one recipient",
    );
  }
  return { method: "age", recipients };
}

async function materializeArchiveTree(input: {
  root: string;
  files: readonly InstallationExportArchiveFile[];
}): Promise<void> {
  for (const file of input.files) {
    const path = join(input.root, file.path);
    await mkdir(dirname(path), { recursive: true });
    if (typeof file.content === "string") {
      await writeFile(path, file.content);
    } else {
      await writeFile(path, file.content);
    }
  }
}

function commandOutput(
  command: string,
  args: readonly string[],
): Promise<{ success: boolean; stderr: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Uint8Array[] = [];
    child.stderr?.on("data", (chunk: Uint8Array) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        success: (code ?? 0) === 0,
        stderr: stderr.length
          ? new Uint8Array(Buffer.concat(stderr))
          : new Uint8Array(),
      });
    });
  });
}

interface NormalizedDataArchiveFile {
  readonly path: string;
  readonly mediaType?: string;
  readonly byteLength: number;
  readonly contentDigest: string;
  readonly content: string | Uint8Array;
}

async function normalizeDataFiles(
  files: readonly InstallationExportArchiveDataFile[],
): Promise<readonly NormalizedDataArchiveFile[]> {
  const seen = new Set<string>();
  const normalized = await Promise.all(files.map(async (file) => {
    const archivePath = normalizeDataArchivePath(file.path);
    if (seen.has(archivePath)) {
      throw new TypeError(
        `duplicate installation export data path: ${archivePath}`,
      );
    }
    seen.add(archivePath);
    const bytes = typeof file.content === "string"
      ? new TextEncoder().encode(file.content)
      : file.content;
    return {
      path: archivePath,
      ...(file.mediaType ? { mediaType: file.mediaType } : {}),
      byteLength: bytes.byteLength,
      contentDigest: await sha256HexBytes(bytes),
      content: file.content,
    };
  }));
  return normalized.sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeDataArchivePath(path: string): string {
  const raw = path.replaceAll("\\", "/");
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new TypeError(
      `installation export data path must stay under ${dataRoot}: ${path}`,
    );
  }
  const normalized = raw.replace(/^\/+/, "");
  const relativeDataPath = normalized.startsWith(`${dataRoot}/`)
    ? normalized.slice(`${dataRoot}/`.length)
    : normalized.startsWith(`${archiveRoot}/`)
    ? ""
    : normalized;
  const segments = relativeDataPath.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError(
      `installation export data path must stay under ${dataRoot}: ${path}`,
    );
  }
  const joined = segments.join("/");
  if (joined === "manifest.json" || joined === "README.md") {
    throw new TypeError(
      `installation export data path is reserved: ${dataRoot}/${joined}`,
    );
  }
  return `${dataRoot}/${joined}`;
}

function dataArchiveFiles(
  dataFiles: readonly NormalizedDataArchiveFile[],
): readonly InstallationExportArchiveFile[] {
  if (dataFiles.length === 0) {
    return [{
      path: `${dataRoot}/README.md`,
      content:
        "# Data export\n\nData dump workers have not attached data partitions to this metadata-only bundle.\n",
    }];
  }
  return [
    {
      path: `${dataRoot}/manifest.json`,
      content: `${
        JSON.stringify(
          {
            kind: dataManifestKind,
            version: "v1",
            files: dataFiles.map((file) => ({
              path: file.path,
              ...(file.mediaType ? { mediaType: file.mediaType } : {}),
              byteLength: file.byteLength,
              contentDigest: file.contentDigest,
            })),
          },
          null,
          2,
        )
      }\n`,
    },
    ...dataFiles.map((file) => ({
      path: file.path,
      content: file.content,
    })),
  ];
}

function artifactDescriptorArchiveContent(
  bundle: AccountsInstallationExportBundle,
  options: BuildInstallationExportArchiveFilesOptions,
): string {
  if (options.artifactDescriptorContent !== undefined) {
    return textWithTrailingNewline(options.artifactDescriptorContent);
  }
  return jsonYaml({
    note: "artifact descriptor content was not provided to this export worker",
    artifactDigest: bundle.source.artifactDigest,
  });
}

function textWithTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function installationProjection(
  bundle: AccountsInstallationExportBundle,
): Record<string, unknown> {
  return {
    installationId: bundle.installation.installationId,
    accountId: bundle.installation.accountId,
    spaceId: bundle.installation.spaceId,
    appId: bundle.installation.appId,
    mode: bundle.installation.mode,
    status: bundle.installation.status,
    source: {
      git: bundle.source.gitUrl,
      ref: bundle.source.ref,
      commit: bundle.source.commit,
    },
    digests: {
      planSnapshot: bundle.source.planSnapshotDigest,
      artifact: bundle.source.artifactDigest,
    },
    runtimeTarget: bundle.runtimeTarget,
  };
}

function oidcUseEdgeTemplate(
  bundle: AccountsInstallationExportBundle,
): Record<string, unknown> {
  const useEdge = bundle.useEdges.find((entry) =>
    entry.kind === "identity.oidc@v1"
  );
  return {
    kind: "takosumi.accounts.oidc-use-edge-template@v1",
    version: "v1",
    installationId: bundle.installation.installationId,
    sourceIssuer: bundle.oidcClient?.issuerUrl ?? null,
    oidcClient: bundle.oidcClient
      ? {
        useEdge: bundle.oidcClient.useEdge,
        servicePath: bundle.oidcClient.servicePath ??
          bundle.oidcClient.namespacePath,
        issuerUrl: bundle.oidcClient.issuerUrl,
        redirectUris: bundle.oidcClient.redirectUris,
        allowedScopes: bundle.oidcClient.allowedScopes,
        subjectMode: bundle.oidcClient.subjectMode,
        tokenEndpointAuthMethod: bundle.oidcClient.tokenEndpointAuthMethod,
      }
      : null,
    useEdge: useEdge
      ? {
        name: useEdge.name,
        kind: useEdge.kind,
        configRef: useEdge.template.configRef,
        secretRefs: useEdge.template.secretRefs,
      }
      : null,
  };
}

function jsonYaml(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizedHttpDirectoryUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("downloadBaseUrl must be an http:// or https:// URL");
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.toString();
}

function requiredDownloadBaseUrl(value: string | undefined): string {
  if (!value) {
    throw new TypeError(
      "downloadBaseUrl is required when no export archive uploader is configured",
    );
  }
  return value;
}

function prefixedObjectKey(
  prefix: string | undefined,
  fileName: string,
): string {
  if (!prefix) return fileName;
  const normalized = prefix.replace(/^\/+|\/+$/g, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new TypeError("objectKeyPrefix must not contain . or .. segments");
  }
  return segments.length > 0 ? `${segments.join("/")}/${fileName}` : fileName;
}

/**
 * Reserved env var name that holds the HMAC-SHA256 secret used to sign
 * installation export download URLs. Operators MUST configure this in
 * production; absence at sign time forces the handler to fall back to
 * "not configured" semantics rather than emit unsigned URLs.
 */
export const EXPORT_DOWNLOAD_SECRET_ENV =
  "TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET";

const EXPORT_DOWNLOAD_SIGNATURE_PARAM = "tk_sig";
const EXPORT_DOWNLOAD_EXPIRES_PARAM = "tk_exp";
const EXPORT_DOWNLOAD_TTL_MS = 5 * 60 * 1000;

export interface ExportDownloadSigningOptions {
  /** HMAC secret (string or raw bytes). */
  readonly secret: string | Uint8Array;
  /** Override `Date.now()` for deterministic tests. */
  readonly now?: () => number;
  /** Override the 5-minute TTL. */
  readonly ttlMs?: number;
}

/**
 * Sign an installation export download URL with HMAC-SHA256.
 *
 * Adds `tk_exp` (ms-since-epoch expiry) and `tk_sig` (base64url HMAC-SHA256
 * of the URL minus `tk_sig`) query parameters. The verifier (see
 * `verifyExportDownloadUrl`) recomputes the same canonical form and uses
 * constant-time comparison.
 */
export async function signExportDownloadUrl(
  rawUrl: string,
  options: ExportDownloadSigningOptions,
): Promise<{ url: string; expiresAt: string }> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("export download URL must be http or https");
  }
  const ttlMs = options.ttlMs ?? EXPORT_DOWNLOAD_TTL_MS;
  const expiresAtMs = (options.now?.() ?? Date.now()) + ttlMs;
  url.searchParams.delete(EXPORT_DOWNLOAD_SIGNATURE_PARAM);
  url.searchParams.set(EXPORT_DOWNLOAD_EXPIRES_PARAM, String(expiresAtMs));
  const signature = await computeExportDownloadSignature(
    url.toString(),
    options.secret,
  );
  url.searchParams.set(EXPORT_DOWNLOAD_SIGNATURE_PARAM, signature);
  return {
    url: url.toString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export type ExportDownloadVerifyResult =
  | { ok: true; expiresAtMs: number }
  | { ok: false; reason: "missing" | "expired" | "signature" };

/**
 * Verify a signed export download URL produced by `signExportDownloadUrl`.
 *
 * Returns a discriminated union rather than throwing so callers can map
 * each failure mode to the correct HTTP envelope (`400 invalid_signature`,
 * `410 expired`, etc.).
 */
export async function verifyExportDownloadUrl(
  rawUrl: string,
  options: {
    readonly secret: string | Uint8Array;
    readonly now?: () => number;
  },
): Promise<ExportDownloadVerifyResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "signature" };
  }
  const presentedSignature = url.searchParams.get(
    EXPORT_DOWNLOAD_SIGNATURE_PARAM,
  );
  const expiresAtRaw = url.searchParams.get(EXPORT_DOWNLOAD_EXPIRES_PARAM);
  if (!presentedSignature || !expiresAtRaw) {
    return { ok: false, reason: "missing" };
  }
  const expiresAtMs = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAtMs)) {
    return { ok: false, reason: "signature" };
  }
  if (expiresAtMs <= (options.now?.() ?? Date.now())) {
    return { ok: false, reason: "expired" };
  }
  url.searchParams.delete(EXPORT_DOWNLOAD_SIGNATURE_PARAM);
  const expected = await computeExportDownloadSignature(
    url.toString(),
    options.secret,
  );
  if (!constantTimeStringEqual(expected, presentedSignature)) {
    return { ok: false, reason: "signature" };
  }
  return { ok: true, expiresAtMs };
}

async function computeExportDownloadSignature(
  payload: string,
  secret: string | Uint8Array,
): Promise<string> {
  const secretBytes = typeof secret === "string"
    ? new TextEncoder().encode(secret)
    : secret;
  if (secretBytes.byteLength === 0) {
    throw new TypeError("export download signing secret must not be empty");
  }
  // Re-allocate on an ArrayBuffer to avoid SharedArrayBuffer typing
  // mismatches with WebCrypto's `BufferSource` parameter.
  const keyMaterial = new Uint8Array(secretBytes.byteLength);
  keyMaterial.set(secretBytes);
  const key = await crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return base64UrlFromBytes(new Uint8Array(digest));
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Read the export download signing secret from the operator-configured env
 * var, returning `undefined` when the var is missing or empty.
 *
 * The handler MUST treat absence as "feature unavailable" rather than
 * fall back to unsigned URLs, because the export bundle may contain
 * tenant-scoped material.
 */
export function readExportDownloadSigningSecretFromEnv(): string | undefined {
  const raw = readEnvVar(EXPORT_DOWNLOAD_SECRET_ENV);
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function restoreGuide(bundle: AccountsInstallationExportBundle): string {
  return `# Restore ${bundle.installation.installationId}

This archive contains a canonical \`takos-export/bundle.json\` payload for Takosumi Accounts import.
OIDC use-edge metadata is also available at \`takos-export/oidc/use-edge-template.json\`.

\`\`\`bash
 takosumi accounts installations import ./takos-export.tar.zst \\
  --to <target-accounts-url> \\
  --account-id <target-account-id> \\
  --space-id <target-space-id> \\
  --subject <takosumi-subject>
\`\`\`

Source commit: \`${bundle.source.commit}\`
Plan snapshot digest: \`${bundle.source.planSnapshotDigest}\`
Artifact digest: \`${bundle.source.artifactDigest ?? "none"}\`

Secret material is not included. Provider use edges must be reissued by the target Accounts instance.
`;
}
