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
  readFile,
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
import { exportDownloadUrl } from "./export-download-url.ts";

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
  readonly artifactDescriptorProvider?: InstallationExportArtifactDescriptorProvider;
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
  readonly archiveDigest?: string;
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
      path: `${archiveRoot}/service-bindings/template.yml`,
      content: jsonYaml({
        service_bindings: bundle.serviceBindings.map((serviceBinding) => ({
          name: serviceBinding.name,
          kind: serviceBinding.kind,
          configRef: serviceBinding.template.configRef,
        })),
      }),
    },
    {
      path: `${archiveRoot}/oidc/service-binding-template.json`,
      content: `${JSON.stringify(oidcServiceBindingTemplate(bundle), null, 2)}\n`,
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
    const clearArchivePath =
      encryption.method === "age"
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
  const uploader =
    options.uploader ??
    createHttpDirectoryInstallationExportArchiveUploader({
      downloadBaseUrl: requiredDownloadBaseUrl(options.downloadBaseUrl),
      outputDirectory: options.outputDirectory,
    });
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  return async (input) => {
    if (
      input.request.includeData &&
      input.request.encryption.method !== "age"
    ) {
      throw new TypeError("export includeData requires age encryption");
    }
    await mkdir(options.outputDirectory, { recursive: true });
    const encrypted = input.request.encryption.method === "age";
    const fileName = `takos-export-${input.operationId}.tar.zst${
      encrypted ? ".age" : ""
    }`;
    const objectKey = prefixedObjectKey(options.objectKeyPrefix, fileName);
    const outputPath = join(options.outputDirectory, fileName);
    const dataFiles =
      input.request.includeData && options.dataProvider
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
    const archiveDigest = await sha256HexBytes(await readFile(outputPath));
    const now = options.now?.() ?? new Date();
    const downloadExpiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const uploaded = await uploader({
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
        artifactDescriptorIncluded:
          artifactDescriptorContent !== undefined ? "true" : "false",
        archiveDigest,
      },
    });
    return { ...uploaded, archiveDigest };
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
  const normalized = await Promise.all(
    files.map(async (file) => {
      const archivePath = normalizeDataArchivePath(file.path);
      if (seen.has(archivePath)) {
        throw new TypeError(
          `duplicate installation export data path: ${archivePath}`,
        );
      }
      seen.add(archivePath);
      const bytes =
        typeof file.content === "string"
          ? new TextEncoder().encode(file.content)
          : file.content;
      return {
        path: archivePath,
        ...(file.mediaType ? { mediaType: file.mediaType } : {}),
        byteLength: bytes.byteLength,
        contentDigest: await sha256HexBytes(bytes),
        content: file.content,
      };
    }),
  );
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
    return [
      {
        path: `${dataRoot}/README.md`,
        content:
          "# Data export\n\nData dump workers have not attached data partitions to this metadata-only bundle.\n",
      },
    ];
  }
  return [
    {
      path: `${dataRoot}/manifest.json`,
      content: `${JSON.stringify(
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
      )}\n`,
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
      plan: bundle.source.planDigest,
      artifact: bundle.source.artifactDigest,
    },
    runtimeTarget: bundle.runtimeTarget,
  };
}

function oidcServiceBindingTemplate(
  bundle: AccountsInstallationExportBundle,
): Record<string, unknown> {
  const serviceBinding = bundle.serviceBindings.find(
    (entry) => entry.kind === "identity.oidc",
  );
  return {
    kind: "takosumi.accounts.oidc-service-binding-template@v1",
    version: "v1",
    installationId: bundle.installation.installationId,
    sourceIssuer: bundle.oidcClient?.issuerUrl ?? null,
    oidcClient: bundle.oidcClient
      ? {
          serviceBinding: bundle.oidcClient.serviceBinding,
          servicePath:
            bundle.oidcClient.servicePath ?? bundle.oidcClient.namespacePath,
          issuerUrl: bundle.oidcClient.issuerUrl,
          redirectUris: bundle.oidcClient.redirectUris,
          allowedScopes: bundle.oidcClient.allowedScopes,
          subjectMode: bundle.oidcClient.subjectMode,
          tokenEndpointAuthMethod: bundle.oidcClient.tokenEndpointAuthMethod,
        }
      : null,
    serviceBinding: serviceBinding
      ? {
          name: serviceBinding.name,
          kind: serviceBinding.kind,
          configRef: serviceBinding.template.configRef,
        }
      : null,
  };
}

function jsonYaml(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizedHttpDirectoryUrl(value: string): string {
  const url = exportDownloadUrl(value, "downloadBaseUrl");
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

function restoreGuide(bundle: AccountsInstallationExportBundle): string {
  return `# Restore ${bundle.installation.installationId}

This archive contains a canonical \`takos-export/bundle.json\` payload for Takosumi Accounts import.
OIDC service-binding metadata is also available at \`takos-export/oidc/service-binding-template.json\`.

Restore this bundle through a Takosumi deploy-control restore/apply flow on the
target Space, then let the target account plane create its Installation
projection from that deploy-control ledger entry. The account-plane import
route is fail-closed until it is wired to that restore flow. Operators may use
\`takosumi internal installations import-plan --bundle-file takos-export/bundle.json\`
to prepare review input or
\`takosumi internal installations import-apply --bundle-file takos-export/bundle.json\`
to run the target PlanRun + projection-create flow. The archive intentionally
does not depend on a public install CLI command.

Source commit: \`${bundle.source.commit}\`
Plan digest digest: \`${bundle.source.planDigest}\`
Artifact digest: \`${bundle.source.artifactDigest ?? "none"}\`

Secret material is not included. Provider service bindings must be reissued by the target Accounts instance.
`;
}
