import type { InstallConfigResourceMigrationAction } from "takosumi-contract/install-configs";

const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const RESOURCE_ADDRESS_RE =
  /^(?:module\.[A-Za-z0-9_-]+\.)*[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const BUNDLE_PATH_RE =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;

export function validateResourceMigrationDeclaration(
  action: InstallConfigResourceMigrationAction,
  field: string,
): void {
  if (action.phase !== "post_apply") {
    throw new Error(`${field}.phase must be post_apply`);
  }
  if (action.executor !== "operator") {
    throw new Error(`${field}.executor must be operator`);
  }
  if (!RESOURCE_ADDRESS_RE.test(action.target.resourceAddress)) {
    throw new Error(`${field}.target.resourceAddress is invalid`);
  }
  if (action.bundle.format !== "takosumi.resource-migrations/v1") {
    throw new Error(`${field}.bundle.format is unsupported`);
  }
  if (!BUNDLE_PATH_RE.test(action.bundle.manifestPath)) {
    throw new Error(`${field}.bundle.manifestPath is invalid`);
  }
  if (!SHA256_DIGEST_RE.test(action.bundle.digest)) {
    throw new Error(`${field}.bundle.digest must be sha256:<lowercase hex>`);
  }
}
