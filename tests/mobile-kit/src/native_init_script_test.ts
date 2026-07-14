import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
  "mobile-kit/scripts/init-tauri-mobile-native.mjs",
);

test("native init script generates then applies platform push wiring", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-init-"));
  try {
    const binDir = path.join(appDir, "bin");
    const fakeBunx = path.join(binDir, "bunx");
    const invocationLog = path.join(appDir, "bunx-args.txt");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      fakeBunx,
      `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
writeFileSync(process.env.FAKE_TAURI_LOG, process.argv.slice(2).join(" "));
const androidRoot = path.join(process.cwd(), "src-tauri/gen/android");
mkdirSync(path.join(androidRoot, "app"), { recursive: true });
writeFileSync(path.join(androidRoot, "build.gradle.kts"), 'plugins {\\n    id("com.android.application") version "8.5.0" apply false\\n}\\n');
writeFileSync(path.join(androidRoot, "app/build.gradle.kts"), 'plugins {\\n    id("com.android.application")\\n}\\n\\ndependencies {\\n}\\n');
`,
    );
    chmodSync(fakeBunx, 0o755);

    const result = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--platform",
        "android",
        "--apple-environment",
        "development",
        "--",
        "--ci",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          FAKE_TAURI_LOG: invocationLog,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(invocationLog, "utf8")).toBe(
      "tauri android init --skip-targets-install --ci",
    );
    expect(
      readFileSync(
        path.join(appDir, "src-tauri/gen/android/build.gradle.kts"),
        "utf8",
      ),
    ).toContain("com.google.gms.google-services");
    expect(
      readFileSync(
        path.join(appDir, "src-tauri/gen/android/app/build.gradle.kts"),
        "utf8",
      ),
    ).toContain("firebase-messaging");
    expect(result.stdout).toContain(
      "Tauri android project generated and integrated.",
    );
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});
