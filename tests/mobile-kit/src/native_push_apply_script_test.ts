import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
const scriptPath = path.join(
  rootDir,
  "mobile-kit/scripts/apply-tauri-mobile-push-native.mjs",
);

test("native push apply script patches generated iOS and Android projects", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-push-"));
  try {
    seedGeneratedNativeProject(appDir);

    const result = spawnSync(
      "bun",
      [scriptPath, "--app-dir", appDir, "--apple-environment", "production"],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("iOS aps-environment entitlement updated");
    expect(result.stdout).toContain(
      "Android app Firebase Messaging Gradle wiring updated",
    );
    expect(read(appDir, "src-tauri/gen/apple/App.entitlements")).toContain(
      "<string>production</string>",
    );
    expect(read(appDir, "src-tauri/gen/android/build.gradle.kts")).toContain(
      'id("com.google.gms.google-services") version "4.5.0" apply false',
    );
    expect(
      read(appDir, "src-tauri/gen/android/app/build.gradle.kts"),
    ).toContain(
      'implementation(platform("com.google.firebase:firebase-bom:34.15.0"))',
    );
    expect(
      read(appDir, "src-tauri/gen/android/app/build.gradle.kts"),
    ).toContain('implementation("com.google.firebase:firebase-installations")');
    expect(
      read(appDir, "src-tauri/gen/android/app/build.gradle.kts"),
    ).toContain('implementation("com.google.firebase:firebase-messaging")');
    expect(
      read(appDir, "src-tauri/gen/android/app/src/main/AndroidManifest.xml"),
    ).not.toContain("FCMService");

    const second = spawnSync(
      "bun",
      [scriptPath, "--app-dir", appDir, "--apple-environment", "production"],
      {
        encoding: "utf8",
      },
    );
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already present");
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("native push apply script strictly verifies generated wiring without mutation", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-push-"));
  try {
    seedGeneratedNativeProject(appDir);

    const before = read(appDir, "src-tauri/gen/android/app/build.gradle.kts");
    const dryRun = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--apple-environment",
        "development",
        "--dry-run",
        "--strict",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(dryRun.status).toBe(1);
    expect(dryRun.stdout).toContain("would be updated");
    expect(read(appDir, "src-tauri/gen/android/app/build.gradle.kts")).toBe(
      before,
    );

    const apply = spawnSync(
      "bun",
      [scriptPath, "--app-dir", appDir, "--apple-environment", "development"],
      { encoding: "utf8" },
    );
    expect(apply.status).toBe(0);

    const verify = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--apple-environment",
        "development",
        "--dry-run",
        "--strict",
      ],
      {
        encoding: "utf8",
      },
    );
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain("already present");
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("native push production verification rejects development entitlements", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-push-"));
  try {
    seedGeneratedNativeProject(appDir);
    const developmentApply = spawnSync(
      "bun",
      [scriptPath, "--app-dir", appDir, "--apple-environment", "development"],
      { encoding: "utf8" },
    );
    expect(developmentApply.status).toBe(0);

    const productionAgainstDevelopment = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--apple-environment",
        "production",
        "--dry-run",
        "--strict",
      ],
      { encoding: "utf8" },
    );
    expect(productionAgainstDevelopment.status).toBe(1);
    expect(productionAgainstDevelopment.stdout).toContain("would be updated");

    const productionApply = spawnSync(
      "bun",
      [scriptPath, "--app-dir", appDir, "--apple-environment", "production"],
      { encoding: "utf8" },
    );
    expect(productionApply.status).toBe(0);

    const productionVerify = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--apple-environment",
        "production",
        "--dry-run",
        "--strict",
      ],
      { encoding: "utf8" },
    );
    expect(productionVerify.status).toBe(0);

    const developmentAgainstProduction = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--apple-environment",
        "development",
        "--dry-run",
        "--strict",
      ],
      { encoding: "utf8" },
    );
    expect(developmentAgainstProduction.status).toBe(1);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("native push apply script strict mode fails on missing generated projects", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-push-"));
  try {
    const result = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--apple-environment",
        "development",
        "--dry-run",
        "--strict",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("src-tauri/gen/apple is missing");
    expect(result.stdout).toContain("src-tauri/gen/android is missing");
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("native push apply script can verify one generated platform", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-push-"));
  try {
    seedGeneratedNativeProject(appDir);
    const appleBefore = read(appDir, "src-tauri/gen/apple/App.entitlements");

    const applyAndroid = spawnSync(
      "bun",
      [scriptPath, "--app-dir", appDir, "--platform", "android"],
      { encoding: "utf8" },
    );
    expect(applyAndroid.status).toBe(0);
    expect(applyAndroid.stdout).toContain(
      "Tauri mobile push native apply (android)",
    );
    expect(applyAndroid.stdout).not.toContain("iOS aps-environment");
    expect(read(appDir, "src-tauri/gen/apple/App.entitlements")).toBe(
      appleBefore,
    );

    const verifyAndroid = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--platform",
        "android",
        "--dry-run",
        "--strict",
      ],
      { encoding: "utf8" },
    );
    expect(verifyAndroid.status).toBe(0);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

function seedGeneratedNativeProject(appDir: string) {
  write(
    appDir,
    "src-tauri/gen/apple/App.entitlements",
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      "<dict>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
  write(
    appDir,
    "src-tauri/gen/android/build.gradle.kts",
    [
      "plugins {",
      '    id("com.android.application") version "8.5.0" apply false',
      "}",
      "",
    ].join("\n"),
  );
  write(
    appDir,
    "src-tauri/gen/android/app/build.gradle.kts",
    [
      "plugins {",
      '    id("com.android.application")',
      "}",
      "",
      "dependencies {",
      "}",
      "",
    ].join("\n"),
  );
  write(appDir, "src-tauri/gen/android/app/google-services.json", "{}\n");
  write(
    appDir,
    "src-tauri/gen/android/app/src/main/AndroidManifest.xml",
    [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
      '    <application android:theme="@style/AppTheme">',
      "    </application>",
      "</manifest>",
      "",
    ].join("\n"),
  );
}

function write(appDir: string, relativePath: string, text: string) {
  const filePath = path.join(appDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, text);
}

function read(appDir: string, relativePath: string) {
  return readFileSync(path.join(appDir, relativePath), "utf8");
}
