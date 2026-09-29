import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat } from "node:fs/promises";
import { join } from "node:path";

const AUTH_COMMAND_TIMEOUT_MS = 2 * 60_000;
const AUTH_COMMAND_OUTPUT_MAX_BYTES = 16 * 1024;
const AUTH_TERMINATION_GRACE_MS = 5_000;
const AUTH_KILL_REAP_GRACE_MS = 1_000;

type Credentials = Readonly<{ username: string; password: string }>;

/** Credentials never enter the generic release command result or diagnostics. */
export async function authorizeRunnerRegistryPull(
  registry: string,
  dockerConfig: string,
  cwd: string,
  wranglerConfig: string,
  accountId: string,
): Promise<void> {
  if (registry !== "registry.cloudflare.com" || !/^[0-9a-f]{32}$/u.test(accountId)) {
    throw new Error("runner_image_pull_auth_registry_invalid");
  }
  const credentials = parseCredentials(
    await sensitiveProcess(
      "bunx",
      [
        "--no-install", "wrangler", "containers", "registries", "credentials", registry,
        "--pull", "--json", "--config", wranglerConfig,
      ],
      cwd,
      undefined,
      true,
      "runner_image_pull_auth_credentials_failed",
      {
        ...runnerAuthEnvironment(accountId),
        WRANGLER_WRITE_LOGS: "false",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_SEND_ERROR_REPORTS: "false",
      },
    ),
  );
  await sensitiveProcess(
    "docker",
    ["--config", dockerConfig, "login", "--password-stdin", "--username", "v1", registry],
    cwd,
    credentials.password,
    false,
    "runner_image_pull_auth_login_failed",
    dockerAuthEnvironment(),
  );
  const config = await lstat(join(dockerConfig, "config.json"));
  if (!config.isFile() || config.isSymbolicLink() || config.nlink !== 1) {
    throw new Error("runner_image_pull_auth_config_invalid");
  }
  await chmod(join(dockerConfig, "config.json"), 0o600);
}

function parseCredentials(output: string): Credentials {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("runner_image_pull_auth_credentials_invalid");
  }
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    !("username" in value) || !("password" in value) ||
    typeof value.username !== "string" || typeof value.password !== "string" ||
    value.username !== "v1" ||
    value.password.length === 0 || value.password.length > 4_096
  ) {
    throw new Error("runner_image_pull_auth_credentials_invalid");
  }
  return { username: value.username, password: value.password };
}

function runnerAuthEnvironment(accountId: string): NodeJS.ProcessEnv {
  const environment = baseEnvironment();
  environment.CLOUDFLARE_ACCOUNT_ID = accountId;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (token !== undefined) environment.CLOUDFLARE_API_TOKEN = token;
  return environment;
}

function dockerAuthEnvironment(): NodeJS.ProcessEnv {
  const environment = baseEnvironment();
  for (const key of [
    "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY",
    "XDG_RUNTIME_DIR",
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/root",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "true",
  };
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The direct process group may already have exited.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The direct child may already have exited.
  }
}

async function sensitiveProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  stdin: string | undefined,
  captureStdout: boolean,
  errorCode: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "";
    let outputBytes = 0;
    let directChildExited = false;
    let settled = false;
    let stopRequested = false;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (reapTimer) clearTimeout(reapTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Error(errorCode));
    };
    const stop = () => {
      if (settled || stopRequested) return;
      stopRequested = true;
      if (directChildExited) {
        fail();
        return;
      }
      terminate(child, "SIGTERM");
      terminationTimer = setTimeout(() => {
        terminate(child, "SIGKILL");
        reapTimer = setTimeout(() => {
          if (!directChildExited) child.unref();
          fail();
        }, AUTH_KILL_REAP_GRACE_MS);
      }, AUTH_TERMINATION_GRACE_MS);
    };
    const timeout = setTimeout(stop, AUTH_COMMAND_TIMEOUT_MS);
    child.stdin.on("error", stop);
    child.stdin.end(stdin);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (value: string) => {
      outputBytes += Buffer.byteLength(value, "utf8");
      if (outputBytes > AUTH_COMMAND_OUTPUT_MAX_BYTES) {
        stop();
        return;
      }
      if (captureStdout) output += value;
    });
    child.stderr.on("data", (value: Buffer) => {
      outputBytes += value.length;
      if (outputBytes > AUTH_COMMAND_OUTPUT_MAX_BYTES) stop();
    });
    child.on("error", fail);
    child.on("exit", () => {
      directChildExited = true;
      if (stopRequested) fail();
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (reapTimer) clearTimeout(reapTimer);
      if (settled) return;
      if (stopRequested || code !== 0) {
        fail();
        return;
      }
      settled = true;
      resolveResult(output);
    });
  });
}
