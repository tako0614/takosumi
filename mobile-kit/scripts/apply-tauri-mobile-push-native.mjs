#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const appDir = path.resolve(args.appDir ?? process.cwd());
const appleEnvironment = args.appleEnvironment ?? "development";
const dryRun = Boolean(args.dryRun);
const strict = Boolean(args.strict);
const results = [];

if (appleEnvironment !== "development" && appleEnvironment !== "production") {
  fail("--apple-environment must be development or production");
  printResults();
  process.exit(2);
}

await applyApplePushEntitlement();
await applyAndroidFirebaseWiring();
printResults();

if (
  results.some((result) => result.kind === "fail") ||
  (strict && results.some((result) => result.kind === "warn"))
) {
  process.exit(1);
}

async function applyApplePushEntitlement() {
  const appleDir = path.join(appDir, "src-tauri/gen/apple");
  if (!existsSync(appleDir)) {
    warn(
      "src-tauri/gen/apple is missing; run tauri ios init before applying iOS push wiring",
    );
    return;
  }

  const entitlementFiles = (await collectFiles(appleDir)).filter((filePath) =>
    filePath.endsWith(".entitlements"),
  );
  if (entitlementFiles.length === 0) {
    warn(
      "no iOS .entitlements file found; add Push Notifications in Xcode, then rerun",
    );
    return;
  }

  for (const filePath of entitlementFiles) {
    const updated = upsertApsEnvironment(readText(filePath), appleEnvironment);
    writeIfChanged(filePath, updated, "iOS aps-environment entitlement");
  }
}

async function applyAndroidFirebaseWiring() {
  const androidDir = path.join(appDir, "src-tauri/gen/android");
  if (!existsSync(androidDir)) {
    warn(
      "src-tauri/gen/android is missing; run tauri android init before applying Android push wiring",
    );
    return;
  }

  const googleServices = path.join(androidDir, "app/google-services.json");
  if (existsSync(googleServices)) {
    ok("Android google-services.json is present");
  } else {
    warn(
      "Android google-services.json is missing at src-tauri/gen/android/app/google-services.json",
    );
  }

  const androidFiles = await collectFiles(androidDir);
  const projectGradle = findByRelative(androidFiles, androidDir, [
    "build.gradle.kts",
    "build.gradle",
  ]);
  const appGradle = findByRelative(androidFiles, androidDir, [
    "app/build.gradle.kts",
    "app/build.gradle",
  ]);
  const manifest = androidFiles.find((filePath) =>
    filePath.endsWith("AndroidManifest.xml"),
  );

  if (projectGradle) {
    writeIfChanged(
      projectGradle,
      patchProjectGradle(
        readText(projectGradle),
        projectGradle.endsWith(".kts"),
      ),
      "Android project Google Services Gradle plugin",
    );
  } else {
    warn("Android project Gradle file is missing");
  }

  if (appGradle) {
    writeIfChanged(
      appGradle,
      patchAppGradle(readText(appGradle), appGradle.endsWith(".kts")),
      "Android app Firebase Messaging Gradle wiring",
    );
  } else {
    warn("Android app Gradle file is missing");
  }

  if (manifest) {
    writeIfChanged(
      manifest,
      patchAndroidManifest(readText(manifest)),
      "Android FCM service manifest entry",
    );
  } else {
    warn("AndroidManifest.xml is missing under src-tauri/gen/android");
  }
}

function upsertApsEnvironment(xml, environment) {
  if (xml.includes("<key>aps-environment</key>")) {
    return xml.replace(
      /(<key>aps-environment<\/key>\s*<string>)([^<]*)(<\/string>)/,
      `$1${environment}$3`,
    );
  }
  return xml.replace(
    /<\/dict>/,
    `\t<key>aps-environment</key>\n\t<string>${environment}</string>\n</dict>`,
  );
}

function patchProjectGradle(text, kotlinDsl) {
  const pluginLine = kotlinDsl
    ? '    id("com.google.gms.google-services") version "4.4.2" apply false'
    : "    id 'com.google.gms.google-services' version '4.4.2' apply false";
  return ensurePluginsLine(text, pluginLine);
}

function patchAppGradle(text, kotlinDsl) {
  const pluginLine = kotlinDsl
    ? '    id("com.google.gms.google-services")'
    : "    id 'com.google.gms.google-services'";
  const bomLine = kotlinDsl
    ? '    implementation(platform("com.google.firebase:firebase-bom:33.8.0"))'
    : "    implementation platform('com.google.firebase:firebase-bom:33.8.0')";
  const messagingLine = kotlinDsl
    ? '    implementation("com.google.firebase:firebase-messaging")'
    : "    implementation 'com.google.firebase:firebase-messaging'";
  return ensureDependenciesLine(
    ensureDependenciesLine(ensurePluginsLine(text, pluginLine), bomLine),
    messagingLine,
  );
}

function ensurePluginsLine(text, line) {
  if (text.includes("com.google.gms.google-services")) return text;
  if (/plugins\s*\{/.test(text)) {
    return text.replace(/plugins\s*\{/, (match) => `${match}\n${line}`);
  }
  return `plugins {\n${line}\n}\n\n${text}`;
}

function ensureDependenciesLine(text, line) {
  if (text.includes(line.trim())) return text;
  if (/dependencies\s*\{/.test(text)) {
    return text.replace(/dependencies\s*\{/, (match) => `${match}\n${line}`);
  }
  return `${text.trimEnd()}\n\ndependencies {\n${line}\n}\n`;
}

function patchAndroidManifest(text) {
  if (text.includes("app.tauri.mobilepush.FCMService")) return text;
  const service = [
    "        <service",
    '            android:name="app.tauri.mobilepush.FCMService"',
    '            android:exported="false">',
    "            <intent-filter>",
    '                <action android:name="com.google.firebase.MESSAGING_EVENT" />',
    "            </intent-filter>",
    "        </service>",
  ].join("\n");
  if (text.includes("</application>")) {
    return text.replace("</application>", `${service}\n    </application>`);
  }
  return text;
}

function findByRelative(files, root, relativePaths) {
  const wanted = new Set(relativePaths);
  return files.find((filePath) =>
    wanted.has(normalizePath(path.relative(root, filePath))),
  );
}

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

function writeIfChanged(filePath, updated, label) {
  const current = readText(filePath);
  if (current === updated) {
    ok(`${label} already present: ${relative(filePath)}`);
    return;
  }
  if (dryRun) {
    warn(`${label} would be updated: ${relative(filePath)}`);
    return;
  }
  writeFileSync(filePath, updated);
  ok(`${label} updated: ${relative(filePath)}`);
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(filePath)));
    else if (entry.isFile()) files.push(filePath);
  }
  return files;
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function relative(filePath) {
  return normalizePath(path.relative(appDir, filePath));
}

function ok(message) {
  results.push({ kind: "ok", message });
}

function warn(message) {
  results.push({ kind: "warn", message });
}

function fail(message) {
  results.push({ kind: "fail", message });
}

function printResults() {
  console.log(`Tauri mobile push native apply: ${appDir}`);
  for (const result of results) {
    const label =
      result.kind === "ok" ? "OK" : result.kind === "warn" ? "WARN" : "FAIL";
    console.log(`${label} ${result.message}`);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) continue;
    const key = arg
      .slice(2)
      .replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (key === "dryRun" || key === "strict") {
      parsed[key] = true;
      continue;
    }
    parsed[key] = argv[index + 1];
    index += 1;
  }
  return parsed;
}
