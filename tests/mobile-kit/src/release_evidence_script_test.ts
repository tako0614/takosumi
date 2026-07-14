import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
const scriptPath = path.join(
  rootDir,
  "mobile-kit/scripts/check-mobile-release-evidence.mjs",
);

test("mobile release evidence script validates public-safe release evidence", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-release-"));
  try {
    seedTauriConfig(appDir, "Takos", "jp.takos.mobile", "1.2.3");
    writeJson(appDir, "release/mobile-release-evidence.json", {
      ...validEvidence(),
      releaseVersion: "1.2.3",
    });

    const result = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--product",
        "takos",
        "--product-name",
        "Takos",
        "--bundle-id",
        "jp.takos.mobile",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "release evidence schema is takos.mobile-release-evidence.v1",
    );
    expect(result.stdout).toContain(
      "deviceSmoke includes Android passed smoke evidence",
    );
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("mobile release evidence script fails on placeholder versions and missing evidence", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-release-"));
  try {
    seedTauriConfig(appDir, "Takos", "jp.takos.mobile", "0.0.0");

    const result = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--product",
        "takos",
        "--product-name",
        "Takos",
        "--bundle-id",
        "jp.takos.mobile",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("must be a real release version");
    expect(result.stdout).toContain("release evidence file is missing");
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("mobile release evidence script rejects example zero digests", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-release-"));
  try {
    seedTauriConfig(appDir, "Takos", "jp.takos.mobile", "1.2.3");
    const digest =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    writeJson(appDir, "release/mobile-release-evidence.json", {
      ...validEvidence(),
      releaseVersion: "1.2.3",
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
    });

    const result = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--product",
        "takos",
        "--product-name",
        "Takos",
        "--bundle-id",
        "jp.takos.mobile",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("must not use the example zero digest");
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("mobile release evidence script rejects mismatched package and Rust versions", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-release-"));
  try {
    seedTauriConfig(appDir, "Takos", "jp.takos.mobile", "1.2.3");
    writeJson(appDir, "package.json", {
      name: "@takos/takos-mobile",
      version: "1.2.4",
    });
    writeJson(appDir, "release/mobile-release-evidence.json", validEvidence());

    const result = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--product",
        "takos",
        "--product-name",
        "Takos",
        "--bundle-id",
        "jp.takos.mobile",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("version.package_json_mismatch");
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("mobile release evidence script requires security, OIDC, and push scenarios", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-release-"));
  try {
    seedTauriConfig(appDir, "Takos", "jp.takos.mobile", "1.2.3");
    const evidence = validEvidence();
    evidence.nativeSecurity.ios.cases = ["first_store"];
    evidence.mobileOidc.scopedApi.cases = ["auth_me"];
    evidence.remotePush.android.result = "failed";
    writeJson(appDir, "release/mobile-release-evidence.json", evidence);

    const result = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--product",
        "takos",
        "--product-name",
        "Takos",
        "--bundle-id",
        "jp.takos.mobile",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "nativeSecurity.ios.cases includes cold_restart",
    );
    expect(result.stdout).toContain(
      "mobileOidc.scopedApi.cases includes denied_scope",
    );
    expect(result.stdout).toContain("remotePush.android.result is passed");
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

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
  writeJson(appDir, "package.json", {
    name: "@takos/takos-mobile",
    version,
  });
  writeText(
    appDir,
    "src-tauri/Cargo.toml",
    `[package]\nname = "takos-mobile"\nversion = "${version}"\n`,
  );
  writeText(
    appDir,
    "src-tauri/Cargo.lock",
    `version = 4\n\n[[package]]\nname = "takos-mobile"\nversion = "${version}"\n`,
  );
}

function writeText(appDir: string, relativePath: string, value: string) {
  const filePath = path.join(appDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value);
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
    signing: {
      ios: {
        teamRef: "private:mobile/takos/apple-team",
        provisioningProfileRef: "private:mobile/takos/profile",
      },
      android: {
        keystoreRef: "private:mobile/takos/keystore",
        playAppSigning: true,
      },
    },
    ...nativeScenarioEvidence(),
    store: {
      appStore: {
        appRef: "private:app-store-connect/takos",
        uploadedBuildRef: "private:app-store-connect/takos/build",
        listingReviewed: true,
        privacyNutritionReviewed: true,
        screenshots: [
          {
            locale: "ja-JP",
            device: "iphone-6.7",
            evidenceRef: "private:mobile/takos/screenshots/app-store",
            sha256: digest,
          },
        ],
      },
      googlePlay: {
        packageName: "jp.takos.mobile",
        uploadedArtifactRef: "private:google-play/takos/aab",
        listingReviewed: true,
        dataSafetyReviewed: true,
        screenshots: [
          {
            locale: "ja-JP",
            device: "phone",
            evidenceRef: "private:mobile/takos/screenshots/play",
            sha256: digest,
          },
        ],
      },
    },
    deviceSmoke: [
      {
        platform: "ios",
        device: "iPhone 15",
        osVersion: "17.5",
        result: "passed",
        capturedAt: "2026-07-01T00:00:00.000Z",
        evidenceRef: "private:mobile/takos/smoke/ios",
      },
      {
        platform: "android",
        device: "Pixel 8",
        osVersion: "14",
        result: "passed",
        capturedAt: "2026-07-01T00:00:00.000Z",
        evidenceRef: "private:mobile/takos/smoke/android",
      },
    ],
  };
}

function nativeScenarioEvidence() {
  const securityCases = [
    "first_store",
    "cold_restart",
    "unlock_cancel",
    "biometric_change",
    "app_upgrade",
    "legacy_migration",
  ];
  const pushCases = [
    "foreground",
    "background",
    "terminated",
    "tap",
    "token_rotation",
  ];
  const passed = (evidenceRef: string, cases?: string[]) => ({
    result: "passed",
    ...(cases ? { cases } : {}),
    capturedAt: "2026-07-01T00:00:00.000Z",
    evidenceRef,
  });
  return {
    nativeSecurity: {
      ios: passed("private:mobile/takos/security/ios", securityCases),
      android: passed("private:mobile/takos/security/android", securityCases),
    },
    remotePush: {
      deliveryBackend: passed("private:mobile/takos/push/backend"),
      ios: passed("private:mobile/takos/push/ios", pushCases),
      android: passed("private:mobile/takos/push/android", pushCases),
    },
    mobileOidc: {
      codeExchange: passed("private:mobile/takos/oidc/code-exchange", [
        "authorization_code_pkce",
        "refresh_rotation",
      ]),
      firstUserProvision: passed(
        "private:mobile/takos/oidc/first-user-provision",
        ["new_account", "repeat_sign_in"],
      ),
      scopedApi: passed("private:mobile/takos/oidc/scoped-api", [
        "auth_me",
        "allowed_scope",
        "denied_scope",
        "wrong_audience_rejected",
      ]),
    },
  };
}
