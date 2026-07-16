import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
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
const ecosystemRoot = path.resolve(rootDir, "..");
const hasRootMobileReleaseAggregate =
  existsSync(path.join(ecosystemRoot, "package.json")) &&
  existsSync(
    path.join(ecosystemRoot, "scripts/report-mobile-release-status.mjs"),
  );

test("mobile release status reports blockers without failing by default", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-status-"));
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
        "--skip-toolchain-probe",
        "--json",
      ],
      {
        encoding: "utf8",
      },
    );

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
    expect(blockerById(report, "tauri.version_placeholder")).toMatchObject({
      actionability: "repo",
      owner: "product-maintainer",
    });
    expect(
      blockerById(report, "native.android.generated_project_missing"),
    ).toMatchObject({
      actionability: "release-environment",
      owner: "release-engineer",
    });
    expect(blockerById(report, "evidence.file_missing")).toMatchObject({
      actionability: "store-evidence",
      owner: "store-release-operator",
    });
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("mobile release status classifies product-owned native configuration", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-status-"));
  try {
    seedTauriConfig(appDir, "Takos", "jp.takos.mobile", "1.2.3");
    mkdirSync(path.join(appDir, "src-tauri/gen/apple"), { recursive: true });
    writeApsEntitlement(appDir, "production");
    mkdirSync(path.join(appDir, "src-tauri/gen/android/app"), {
      recursive: true,
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
        "--skip-toolchain-probe",
        "--json",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ready).toBe(false);
    expect(report.blockers).toHaveLength(1);
    expect(
      blockerById(report, "native.android.google_services_missing"),
    ).toMatchObject({
      actionability: "operator-config",
      owner: "mobile-operator",
    });
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("mobile release status rejects CI-only or malformed Firebase configuration", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-status-"));
  try {
    seedTauriConfig(appDir, "Takos", "jp.takos.mobile", "1.2.3");
    writeApsEntitlement(appDir, "production");
    seedAndroidReleaseProject(appDir);
    writeJson(appDir, "src-tauri/gen/android/app/google-services.json", {});
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
        "--skip-toolchain-probe",
        "--json",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(
      blockerById(report, "native.android.google_services_invalid"),
    ).toMatchObject({
      actionability: "operator-config",
      owner: "mobile-operator",
    });
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test.skipIf(!hasRootMobileReleaseAggregate)(
  "root mobile release status emits one JSON aggregate",
  () => {
    const result = spawnSync(
      "bun",
      ["run", "status:mobile-apps:release", "--", "--json"],
      {
        cwd: ecosystemRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.schema).toBe("takos.mobile-release-status-aggregate.v1");
    expect(report.products).toHaveLength(3);
    expect(report.summary.productCount).toBe(3);
    expect(report.summary.blockerCount).toBe(
      report.products.reduce(
        (count: number, product: { blockers: unknown[] }) =>
          count + product.blockers.length,
        0,
      ),
    );

    for (const product of report.products) {
      for (const blocker of product.blockers) {
        expect(typeof blocker.actionability).toBe("string");
        expect(typeof blocker.owner).toBe("string");
      }
    }

    const yurucommu = report.products.find(
      (product: { product: string }) => product.product === "yurucommu",
    );
    expect(yurucommu).toBeDefined();
    if (
      !existsSync(path.join(ecosystemRoot, "yurucommu-mobile/package.json"))
    ) {
      expect(yurucommu).toMatchObject({
        present: false,
        skipped: true,
        status: "skipped",
        ready: null,
        blockers: [],
      });
      expect(yurucommu.skipReason).toContain(
        "yurucommu-mobile/package.json is not present",
      );
    }
    const takos = report.products.find(
      (product: { product: string }) => product.product === "takos",
    );
    expect(takos).toBeDefined();
    expect(
      report.products.find(
        (product: { product: string }) => product.product === "yurume",
      ),
    ).toBeDefined();
    expect(takos.facts.remotePush).toMatchObject({
      enabled: true,
      providers: ["apns", "fcm"],
      deliveryBackend: "takos.notification-pusher-gateway.v1",
    });
    expect(blockerIds(takos)).not.toContain(
      "remote_push.native_implementation_missing",
    );
    expect(blockerIds(takos)).not.toContain(
      "remote_push.delivery_backend_missing",
    );
    expect(blockerIds(takos)).not.toContain(
      "remote_push.delivery_backend_incomplete",
    );
  },
);

test("mobile release status can fail when blockers are requested as fatal", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-status-"));
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
        "--skip-toolchain-probe",
        "--fail-on-blockers",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("State: BLOCKED");
    expect(result.stdout).toContain("tauri.version_placeholder");
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("mobile repo release gate ignores only external release blockers", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-status-"));
  try {
    seedTauriConfig(appDir, "Takos", "jp.takos.mobile", "1.2.3");
    const externalOnly = spawnSync(
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
        "--skip-toolchain-probe",
        "--fail-on-repo-blockers",
      ],
      { encoding: "utf8" },
    );
    expect(externalOnly.status).toBe(0);
    expect(externalOnly.stdout).toContain(
      "native.apple.generated_project_missing",
    );
    expect(externalOnly.stdout).toContain("evidence.file_missing");

    seedTauriConfig(appDir, "Wrong Product", "jp.takos.mobile", "1.2.3");
    const repositoryMismatch = spawnSync(
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
        "--skip-toolchain-probe",
        "--fail-on-repo-blockers",
      ],
      { encoding: "utf8" },
    );
    expect(repositoryMismatch.status).toBe(1);
    expect(repositoryMismatch.stdout).toContain("tauri.product_name_mismatch");
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("mobile release status reports ready when static release artifacts are present", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-status-"));
  try {
    seedTauriConfig(appDir, "Takos", "jp.takos.mobile", "1.2.3");
    mkdirSync(path.join(appDir, "src-tauri/gen/apple"), { recursive: true });
    writeApsEntitlement(appDir, "production");
    seedAndroidReleaseProject(appDir);
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
        "--skip-toolchain-probe",
        "--json",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("mobile release status uses the full store evidence contract", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-status-"));
  try {
    seedTauriConfig(appDir, "Takos", "jp.takos.mobile", "1.2.3");
    writeApsEntitlement(appDir, "production");
    seedAndroidReleaseProject(appDir);
    const evidence: Record<string, unknown> = validEvidence();
    delete evidence.signing;
    delete evidence.store;
    delete evidence.deviceSmoke;
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
        "--skip-toolchain-probe",
        "--json",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ready).toBe(false);
    expect(blockerIds(report)).toContain(
      "evidence.signing_ios_team_ref_missing",
    );
    expect(blockerIds(report)).toContain(
      "evidence.store_app_store_app_ref_missing",
    );
    expect(blockerIds(report)).toContain("evidence.device_smoke_missing");
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("mobile release status requires a production APNs entitlement", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-status-"));
  try {
    seedTauriConfig(appDir, "Takos", "jp.takos.mobile", "1.2.3");
    writeApsEntitlement(appDir, "development");
    seedAndroidReleaseProject(appDir);
    writeJson(appDir, "release/mobile-release-evidence.json", validEvidence());

    const development = spawnSync(
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
        "--skip-toolchain-probe",
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(development.status).toBe(0);
    expect(blockerIds(JSON.parse(development.stdout))).toContain(
      "native.apple.aps_environment_not_production",
    );

    writeApsEntitlement(appDir, "production");
    const production = spawnSync(
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
        "--skip-toolchain-probe",
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(production.status).toBe(0);
    expect(blockerIds(JSON.parse(production.stdout))).not.toContain(
      "native.apple.aps_environment_not_production",
    );
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("mobile release status reports mismatched package and Rust versions", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-status-"));
  try {
    seedTauriConfig(appDir, "Takos", "jp.takos.mobile", "1.2.3");
    writeJson(appDir, "package.json", {
      name: "@takos/takos-mobile",
      version: "1.2.4",
    });
    writeText(
      appDir,
      "src-tauri/Cargo.toml",
      '[package]\nname = "takos-mobile"\nversion = "1.2.5"\n',
    );
    writeText(
      appDir,
      "src-tauri/Cargo.lock",
      'version = 4\n\n[[package]]\nname = "takos-mobile"\nversion = "1.2.6"\n',
    );

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
        "--skip-toolchain-probe",
        "--json",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(blockerIds(report)).toContain("version.package_json_mismatch");
    expect(blockerIds(report)).toContain("version.cargo_toml_mismatch");
    expect(blockerIds(report)).toContain("version.cargo_lock_mismatch");
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

function blockerIds(report: { blockers: Array<{ id: string }> }) {
  return report.blockers.map((blocker) => blocker.id);
}

function blockerById(
  report: {
    blockers: Array<{
      id: string;
      actionability: string;
      owner: string;
    }>;
  },
  id: string,
) {
  return report.blockers.find((blocker) => blocker.id === id);
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

function writeApsEntitlement(
  appDir: string,
  environment: "development" | "production",
) {
  writeText(
    appDir,
    "src-tauri/gen/apple/App.entitlements",
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      "<dict>",
      "  <key>aps-environment</key>",
      `  <string>${environment}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
}

function seedAndroidReleaseProject(appDir: string) {
  writeJson(appDir, "src-tauri/gen/android/app/google-services.json", {
    project_info: {
      project_number: "123456789012",
      project_id: "takos-mobile-release-test",
    },
    client: [
      {
        client_info: {
          mobilesdk_app_id: "1:123456789012:android:abcdef1234567890",
          android_client_info: { package_name: "jp.takos.mobile" },
        },
        api_key: [{ current_key: "release-test-public-firebase-api-key" }],
      },
    ],
    configuration_version: "1",
  });
  writeText(
    appDir,
    "src-tauri/gen/android/build.gradle.kts",
    'plugins { id("com.google.gms.google-services") version "4.5.0" apply false }\n',
  );
  writeText(
    appDir,
    "src-tauri/gen/android/app/build.gradle.kts",
    [
      'plugins { id("com.google.gms.google-services") }',
      "dependencies {",
      '  implementation("com.google.firebase:firebase-messaging")',
      '  implementation("com.google.firebase:firebase-installations")',
      "}",
      "",
    ].join("\n"),
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
