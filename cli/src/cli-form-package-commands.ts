import { readFile } from "node:fs/promises";
import {
  installedFormReferenceKey,
  isFormRef,
  isInstalledFormReference,
  isSha256Digest,
  type FormRef,
  type InstalledFormReference,
} from "takosumi-contract";
import { INTERNAL_V1_PREFIX } from "takosumi-contract/api-surface";
import { requestDeployControlApi } from "./cli-deploy-control-api.ts";
import { formPackagesHelpText } from "./cli-help.ts";
import type { CliIo } from "./cli-io.ts";
import {
  booleanOption,
  optionalStringOption,
  parseOptions,
} from "./cli-options.ts";
import { isRecord, parseJson, stringValue } from "./cli-util.ts";

type Options = Record<string, string | boolean>;

interface InstallRequest {
  readonly artifactRef: string;
  readonly expectedPackageDigest: string;
}

interface SafeVerificationResponse {
  readonly verified: true;
  readonly packageDigest: string;
  readonly verifierId: string;
  readonly status: "installed" | "deprecated" | "revoked";
  readonly definitionRefs: readonly FormRef[];
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly identity?: InstalledFormReference;
}

export async function runFormPackages(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || args.includes("--help") || args.includes("-h")) {
    io.stdout(formPackagesHelpText());
    return 0;
  }
  try {
    switch (command) {
      case "install":
        return await operate("install", rest, io);
      case "reverify":
        return await operate("reverify", rest, io);
      default:
        io.stderr(`Unknown form-packages command: ${command}`);
        io.stderr(formPackagesHelpText());
        return 2;
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return error instanceof TypeError ? 2 : 1;
  }
}

async function operate(
  operation: "install" | "reverify",
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  const request = await readRequest(operation, options);
  const response = await requestDeployControlApi({
    path: `${INTERNAL_V1_PREFIX}/form-packages/${operation}`,
    method: "POST",
    body: request,
    options,
  });
  const verification = verificationResponse(response, operation, request);
  io.stdout(formatVerification(verification, booleanOption(options, "json")));
  return 0;
}

async function readRequest(
  operation: "install" | "reverify",
  options: Options,
): Promise<InstallRequest | InstalledFormReference> {
  const path = optionalStringOption(options, "file");
  if (!path) throw new TypeError("--file is required");
  const value = parseJson(await readFile(path, "utf8"));
  if (!isRecord(value)) {
    throw new TypeError("--file must contain a JSON object");
  }
  if (operation === "reverify") {
    if (!isInstalledFormReference(value)) {
      throw new TypeError(
        "reverify file must contain only an exact formRef and packageDigest",
      );
    }
    return {
      formRef: { ...value.formRef },
      packageDigest: value.packageDigest,
    };
  }
  if (
    Object.keys(value).length !== 2 ||
    !("artifactRef" in value) ||
    !("expectedPackageDigest" in value) ||
    typeof value.artifactRef !== "string" ||
    value.artifactRef.trim() === "" ||
    value.artifactRef.length > 2048 ||
    /[\u0000-\u001f\u007f]/u.test(value.artifactRef) ||
    !isSha256Digest(value.expectedPackageDigest)
  ) {
    throw new TypeError(
      "install file must contain only a valid artifactRef and exact expectedPackageDigest",
    );
  }
  return {
    artifactRef: value.artifactRef,
    expectedPackageDigest: value.expectedPackageDigest,
  };
}

function verificationResponse(
  value: unknown,
  operation: "install" | "reverify",
  request: InstallRequest | InstalledFormReference,
): SafeVerificationResponse {
  if (
    !isRecord(value) ||
    value.verified !== true ||
    !isSha256Digest(value.packageDigest) ||
    typeof value.verifierId !== "string" ||
    value.verifierId.trim() === "" ||
    value.verifierId.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value.verifierId) ||
    (value.status !== "installed" &&
      value.status !== "deprecated" &&
      value.status !== "revoked") ||
    !Array.isArray(value.definitionRefs) ||
    !value.definitionRefs.every(isFormRef) ||
    !isIsoTimestamp(value.installedAt) ||
    !isIsoTimestamp(value.updatedAt)
  ) {
    throw new Error("Takosumi returned an invalid Form Package verification");
  }
  const expectedDigest =
    operation === "install"
      ? (request as InstallRequest).expectedPackageDigest
      : (request as InstalledFormReference).packageDigest;
  if (value.packageDigest !== expectedDigest) {
    throw new Error("Takosumi returned a mismatched Form Package digest");
  }
  let identity: InstalledFormReference | undefined;
  if (operation === "reverify") {
    if (
      !isInstalledFormReference(value.identity) ||
      installedFormReferenceKey(value.identity) !==
        installedFormReferenceKey(request as InstalledFormReference)
    ) {
      throw new Error("Takosumi returned a mismatched installed Form identity");
    }
    identity = {
      formRef: { ...value.identity.formRef },
      packageDigest: value.identity.packageDigest,
    };
  }
  return {
    verified: true,
    packageDigest: value.packageDigest,
    verifierId: value.verifierId,
    status: value.status,
    definitionRefs: value.definitionRefs.map((ref) => ({ ...ref })),
    installedAt: value.installedAt,
    updatedAt: value.updatedAt,
    ...(identity ? { identity } : {}),
  };
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function formatVerification(
  value: SafeVerificationResponse,
  asJson: boolean,
): string {
  if (asJson) return JSON.stringify(value, null, 2);
  const definitions = Array.isArray(value.definitionRefs)
    ? value.definitionRefs.length
    : 0;
  return [
    `verified ${stringValue(value.packageDigest) ?? "unknown-digest"}`,
    `verifier=${stringValue(value.verifierId) ?? "unknown"}`,
    `status=${stringValue(value.status) ?? "unknown"}`,
    `definitions=${definitions}`,
  ].join("  ");
}
