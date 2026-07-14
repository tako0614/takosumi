import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Read every version source that contributes to a packaged Tauri application.
 * A release is reproducible only when JavaScript metadata, Tauri metadata, the
 * Rust crate, and the checked-in Rust lockfile identify the same product
 * version.
 */
export function inspectMobileReleaseVersions(appDir, tauriVersion) {
  const issues = [];
  const packageVersion = readPackageJsonVersion(appDir, issues);
  const cargoPackage = readCargoPackage(appDir, issues);
  const cargoLockVersion = readCargoLockVersion(
    appDir,
    cargoPackage?.name,
    issues,
  );

  compareVersion(
    "version.package_json_mismatch",
    "package.json version does not match Tauri version.",
    packageVersion,
    tauriVersion,
    "Update package.json and src-tauri/tauri.conf.json to the same product release version.",
    issues,
  );
  compareVersion(
    "version.cargo_toml_mismatch",
    "Cargo.toml package version does not match Tauri version.",
    cargoPackage?.version,
    tauriVersion,
    "Update src-tauri/Cargo.toml and src-tauri/tauri.conf.json to the same product release version.",
    issues,
  );
  compareVersion(
    "version.cargo_lock_mismatch",
    "Cargo.lock package version does not match Tauri version.",
    cargoLockVersion,
    tauriVersion,
    "Regenerate src-tauri/Cargo.lock after setting the Rust crate release version.",
    issues,
  );

  return {
    tauriVersion,
    packageVersion,
    cargoPackageName: cargoPackage?.name,
    cargoVersion: cargoPackage?.version,
    cargoLockVersion,
    issues,
  };
}

function readPackageJsonVersion(appDir, issues) {
  const filePath = path.join(appDir, "package.json");
  if (!existsSync(filePath)) {
    issues.push(
      versionIssue(
        "version.package_json_missing",
        "package.json is missing from the mobile release source.",
        "package.json does not exist.",
        "Restore package.json and set its version before release.",
      ),
    );
    return undefined;
  }
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8"));
    const version = optionalText(value?.version);
    if (version) return version;
    issues.push(
      versionIssue(
        "version.package_json_version_missing",
        "package.json has no release version.",
        "package.json version is missing or blank.",
        "Set package.json version to the product release version.",
      ),
    );
  } catch (cause) {
    issues.push(
      versionIssue(
        "version.package_json_invalid",
        "package.json cannot be read for release version verification.",
        `package.json is invalid JSON: ${cause.message}`,
        "Fix package.json before release.",
      ),
    );
  }
  return undefined;
}

function readCargoPackage(appDir, issues) {
  const filePath = path.join(appDir, "src-tauri/Cargo.toml");
  if (!existsSync(filePath)) {
    issues.push(
      versionIssue(
        "version.cargo_toml_missing",
        "Cargo.toml is missing from the mobile release source.",
        "src-tauri/Cargo.toml does not exist.",
        "Restore src-tauri/Cargo.toml and set its package version before release.",
      ),
    );
    return undefined;
  }
  const section = tomlSection(readFileSync(filePath, "utf8"), "package");
  const name = quotedTomlValue(section, "name");
  const version = quotedTomlValue(section, "version");
  if (!name || !version) {
    issues.push(
      versionIssue(
        "version.cargo_toml_package_invalid",
        "Cargo.toml package metadata is incomplete.",
        "src-tauri/Cargo.toml [package] must contain quoted name and version values.",
        "Fix the Rust package metadata before release.",
      ),
    );
    return undefined;
  }
  return { name, version };
}

function readCargoLockVersion(appDir, packageName, issues) {
  const filePath = path.join(appDir, "src-tauri/Cargo.lock");
  if (!existsSync(filePath)) {
    issues.push(
      versionIssue(
        "version.cargo_lock_missing",
        "Cargo.lock is missing from the mobile release source.",
        "src-tauri/Cargo.lock does not exist.",
        "Generate and commit the Rust lockfile before release.",
      ),
    );
    return undefined;
  }
  if (!packageName) return undefined;
  const blocks = readFileSync(filePath, "utf8")
    .split(/^\[\[package\]\]\s*$/mu)
    .slice(1);
  for (const block of blocks) {
    if (quotedTomlValue(block, "name") !== packageName) continue;
    const version = quotedTomlValue(block, "version");
    if (version) return version;
  }
  issues.push(
    versionIssue(
      "version.cargo_lock_package_missing",
      "Cargo.lock does not contain the mobile Rust package.",
      `src-tauri/Cargo.lock has no package entry for ${packageName}.`,
      "Regenerate src-tauri/Cargo.lock from the current Cargo.toml.",
    ),
  );
  return undefined;
}

function compareVersion(
  id,
  label,
  sourceVersion,
  tauriVersion,
  action,
  issues,
) {
  if (!sourceVersion || !tauriVersion || sourceVersion === tauriVersion) return;
  issues.push(
    versionIssue(
      id,
      label,
      `Found ${sourceVersion}; Tauri declares ${tauriVersion}.`,
      action,
    ),
  );
}

function versionIssue(id, label, detail, action) {
  return { id, label, detail, action };
}

function tomlSection(source, name) {
  const matcher = new RegExp(`^\\[${escapeRegExp(name)}\\]\\s*$`, "mu");
  const start = matcher.exec(source);
  if (!start) return "";
  const rest = source.slice(start.index + start[0].length);
  const next = /^\[/mu.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function quotedTomlValue(source, key) {
  const matcher = new RegExp(
    `^\\s*${escapeRegExp(key)}\\s*=\\s*\"([^\"]+)\"\\s*$`,
    "mu",
  );
  return optionalText(matcher.exec(source)?.[1]);
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
