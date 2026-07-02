import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
const scriptPath = path.join(
  rootDir,
  "mobile-kit/scripts/report-mobile-release-status.mjs",
);

test("mobile release status reports blockers without failing by default", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-status-"));
  try {
    seedTauriConfig(appDir, "Takos", "jp.takos.mobile", "0.0.0");

    const result = spawnSync("bun", [
      scriptPath,
      "--app-dir",
      appDir,
      "--product",
      "takos",
      "--product-name",
      "Takos",
      "--bundle-id",
      "jp.takos.mobile",
      "--skip-toolchain-probe",
      "--json",
    ], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ready).toBe(false);
    expect(blockerIds(report)).toContain("tauri.version_placeholder");
    expect(blockerIds(report)).toContain(
      "native.apple.generated_project_missing",
    );
    expect(blockerIds(report)).toContain(
      "native.android.generated_project_missing",
    );
    expect(blockerIds(report)).toContain("evidence.file_missing");
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("mobile release status can fail when blockers are requested as fatal", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-status-"));
  try {
    seedTauriConfig(appDir, "Takos", "jp.takos.mobile", "0.0.0");

    const result = spawnSync("bun", [
      scriptPath,
      "--app-dir",
      appDir,
      "--product",
      "takos",
      "--product-name",
      "Takos",
      "--bundle-id",
      "jp.takos.mobile",
      "--skip-toolchain-probe",
      "--fail-on-blockers",
    ], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("State: BLOCKED");
    expect(result.stdout).toContain("tauri.version_placeholder");
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("mobile release status reports ready when static release artifacts are present", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-status-"));
  try {
    seedTauriConfig(appDir, "Takos", "jp.takos.mobile", "1.2.3");
    mkdirSync(path.join(appDir, "src-tauri/gen/apple"), { recursive: true });
    mkdirSync(path.join(appDir, "src-tauri/gen/android/app"), {
      recursive: true,
    });
    writeFileSync(
      path.join(appDir, "src-tauri/gen/android/app/google-services.json"),
      "{}\n",
    );
    writeJson(appDir, "release/mobile-release-evidence.json", validEvidence());

    const result = spawnSync("bun", [
      scriptPath,
      "--app-dir",
      appDir,
      "--product",
      "takos",
      "--product-name",
      "Takos",
      "--bundle-id",
      "jp.takos.mobile",
      "--skip-toolchain-probe",
      "--json",
    ], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

function blockerIds(report: { blockers: Array<{ id: string }> }) {
  return report.blockers.map((blocker) => blocker.id);
}

function seedTauriConfig(
  appDir: string,
  productName: string,
  identifier: string,
  version: string,
) {
  writeJson(appDir, "src-tauri/tauri.conf.json", {
    productName,
    identifier,
    version,
  });
}

function writeJson(appDir: string, relativePath: string, value: unknown) {
  const filePath = path.join(appDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function validEvidence() {
  const digest =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  return {
    schema: "takos.mobile-release-evidence.v1",
    product: "takos",
    productName: "Takos",
    bundleId: "jp.takos.mobile",
    releaseVersion: "1.2.3",
    generatedAt: "2026-07-01T00:00:00.000Z",
    artifacts: {
      iosArchive: {
        evidenceRef: "private:mobile/takos/ios/archive",
        sha256: digest,
      },
      androidAab: {
        evidenceRef: "private:mobile/takos/android/aab",
        sha256: digest,
      },
    },
  };
}
