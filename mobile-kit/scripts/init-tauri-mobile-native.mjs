#!/usr/bin/env bun
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const appDir = path.resolve(args.appDir ?? process.cwd());
const platform = args.platform;
const appleEnvironment = args.appleEnvironment ?? "development";

if (platform !== "android" && platform !== "ios") {
  console.error("--platform is required and must be android or ios");
  process.exit(2);
}
if (appleEnvironment !== "development" && appleEnvironment !== "production") {
  console.error("--apple-environment must be development or production");
  process.exit(2);
}

const initArgs = ["tauri", platform, "init"];
if (
  platform === "android" &&
  !args.forwarded.includes("--skip-targets-install")
) {
  initArgs.push("--skip-targets-install");
}
initArgs.push(...args.forwarded);

console.log(`==> Generate Tauri ${platform} project`);
const initCode = await run("bunx", initArgs);
if (initCode !== 0) {
  console.error(`Tauri ${platform} init failed with exit code ${initCode}.`);
  process.exit(initCode);
}

console.log(`\n==> Apply product native push wiring (${platform})`);
const applyScript = fileURLToPath(
  new URL("./apply-tauri-mobile-push-native.mjs", import.meta.url),
);
const applyCode = await run("bun", [
  applyScript,
  "--app-dir",
  appDir,
  "--platform",
  platform,
  "--apple-environment",
  appleEnvironment,
]);
if (applyCode !== 0) {
  console.error(
    `Applying ${platform} native push wiring failed with exit code ${applyCode}.`,
  );
  process.exit(applyCode);
}

console.log(`\nTauri ${platform} project generated and integrated.`);

function run(command, commandArgs) {
  return new Promise((resolveExit) => {
    const child = spawn(command, commandArgs, {
      cwd: appDir,
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code) => resolveExit(code ?? 1));
    child.on("error", (error) => {
      console.error(error);
      resolveExit(1);
    });
  });
}

function parseArgs(argv) {
  const parsed = { forwarded: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      parsed.forwarded.push(...argv.slice(index + 1));
      break;
    }
    if (
      arg === "--platform" ||
      arg === "--app-dir" ||
      arg === "--apple-environment"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        console.error(`${arg} requires a value`);
        process.exit(2);
      }
      const key = arg
        .slice(2)
        .replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      parsed[key] = value;
      index += 1;
      continue;
    }
    parsed.forwarded.push(arg);
  }
  return parsed;
}
