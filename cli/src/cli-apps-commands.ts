import { randomUUID } from "node:crypto";
import { isJapaneseCli } from "./cli-help.ts";
import type { CliIo } from "./cli-io.ts";
import { booleanOption, optionalStringOption, parseOptions } from "./cli-options.ts";
import {
  DeployControlApiError,
  requestDeployControlApi,
} from "./cli-deploy-control-api.ts";
import { isRecord, stringValue } from "./cli-util.ts";

const APPS_PATH = "/api/v1/apps";
const INSTALL_PLANS_PATH = "/api/v1/install-plans";

function isMissingAppRoute(error: unknown): error is DeployControlApiError {
  return error instanceof DeployControlApiError && error.status === 404 &&
    (error.code === undefined || ["route_not_found", "fixture_route_not_found"].includes(error.code) ||
      (error.code === "not_found" && isRecord(error.body) && error.body.error === "not_found"));
}

export async function runApps(args: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    io.stdout(appsHelpText());
    return 0;
  }
  if (command === "list") return await runAppsList(rest, io);
  if (command === "install") return await runAppInstall(rest, io);
  if (command === "uninstall") return await runAppUninstall(rest, io);
  io.stderr(`${isJapaneseCli() ? "不明なアプリコマンド" : "Unknown app command"}: ${command}`);
  io.stderr(appsHelpText());
  return 2;
}

export async function runAppsList(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(appsListHelpText());
    return 0;
  }
  const workspaceId = optionalStringOption(options, "workspace");
  try {
    let response: unknown;
    let path = APPS_PATH;
    try {
      response = await requestDeployControlApi({
        path,
        options,
        auth: "accounts",
      });
    } catch (error) {
      if (!isMissingAppRoute(error) || !workspaceId) {
        throw error;
      }
      path = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/installed-apps`;
      response = await requestDeployControlApi({ path, options, auth: "accounts" });
    }
    response = await collectAppPages(response, path, options);
    io.stdout(formatAppsList(response, booleanOption(options, "json")));
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runAppInstall(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(appsInstallHelpText());
    return 0;
  }
  const gitUrl = optionalStringOption(options, "git");
  if (!gitUrl) {
    io.stderr("--git is required");
    return 2;
  }
  const workspaceId = optionalStringOption(options, "workspace");
  const requestedIdempotencyKey = options.idempotencyKey;
  if (requestedIdempotencyKey !== undefined && (
    typeof requestedIdempotencyKey !== "string" ||
    requestedIdempotencyKey.length === 0 ||
    requestedIdempotencyKey.trim() !== requestedIdempotencyKey ||
    new TextEncoder().encode(requestedIdempotencyKey).length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(requestedIdempotencyKey)
  )) {
    io.stderr("--idempotency-key must be 1-256 bytes without control characters");
    return 2;
  }
  const idempotencyKey = typeof requestedIdempotencyKey === "string"
    ? requestedIdempotencyKey
    : randomUUID();
  const attemptHeaders = { "Idempotency-Key": idempotencyKey };
  const source: Record<string, string> = { url: gitUrl };
  for (const [option, field] of [
    ["ref", "ref"],
    ["path", "path"],
    ["name", "name"],
  ] as const) {
    const value = optionalStringOption(options, option);
    if (value) source[field] = value;
  }
  const capsule: Record<string, string> = {};
  const capsuleName = optionalStringOption(options, "appName");
  const environment = optionalStringOption(options, "environment");
  if (capsuleName) capsule.name = capsuleName;
  if (environment) capsule.environment = environment;
  const body = {
    mode: "attempt",
    source,
    ...(Object.keys(capsule).length > 0 ? { capsule } : {}),
  };
  try {
    let response: unknown;
    try {
      response = await requestDeployControlApi({
        path: INSTALL_PLANS_PATH,
        method: "POST",
        body,
        options,
        auth: "accounts",
        extraHeaders: attemptHeaders,
      });
    } catch (error) {
      if (!isMissingAppRoute(error) || !workspaceId) {
        if (isMissingAppRoute(error) && !workspaceId) {
          throw new Error(isJapaneseCli()
            ? "このサーバーはワークスペースなしのアプリインストールに対応していません。サーバーを更新するか、旧サーバーとの互換利用で --workspace を指定してください。"
            : "Workspace-less app install is not available on this server; update the server or pass --workspace for legacy compatibility.");
        }
        throw error;
      }
      response = await requestDeployControlApi({
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/install-plans`,
        method: "POST",
        body,
        options,
        auth: "accounts",
        extraHeaders: attemptHeaders,
      });
    }
    io.stdout(formatAppInstall(response, booleanOption(options, "json")));
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runAppUninstall(args: string[], io: CliIo): Promise<number> {
  const [capsuleId, ...rest] = args;
  const options = parseOptions(rest);
  if (options.help) {
    io.stdout(appsUninstallHelpText());
    return 0;
  }
  if (!capsuleId || capsuleId.startsWith("--")) {
    io.stderr(isJapaneseCli() ? "アプリID が必要です" : "app id is required");
    return 2;
  }
  if (!booleanOption(options, "yes")) {
    io.stderr(isJapaneseCli()
      ? `アプリ ${capsuleId} のアンインストールを開始するには --yes を指定してください。`
      : `Pass --yes to confirm uninstalling app ${capsuleId}.`);
    return 2;
  }
  try {
    const response = await requestDeployControlApi({
      path: `/api/v1/capsules/${encodeURIComponent(capsuleId)}/uninstall`,
      method: "POST",
      body: {},
      options,
      auth: "accounts",
    });
    io.stdout(formatAppUninstall(capsuleId, response, booleanOption(options, "json")));
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function formatAppsList(value: unknown, json: boolean): string {
  if (json) return JSON.stringify(value, null, 2);
  if (!isRecord(value)) return JSON.stringify(value);
  const apps = Array.isArray(value.apps)
    ? value.apps
    : Array.isArray(value.installedApps)
      ? value.installedApps
      : [];
  if (apps.length === 0) return isJapaneseCli() ? "アプリはありません" : "No apps";
  return apps.map((entry) => {
    if (!isRecord(entry)) return JSON.stringify(entry);
    const id = stringValue(entry.capsuleId) ?? stringValue(entry.id) ?? "?";
    const name = stringValue(entry.displayName) ?? stringValue(entry.name) ?? id;
    const state = stringValue(entry.state) ?? "unknown";
    return `${name} (${id}) — ${state}`;
  }).join("\n");
}

function formatAppInstall(value: unknown, json: boolean): string {
  if (json) return JSON.stringify(value, null, 2);
  const plan = isRecord(value) && isRecord(value.installPlan) ? value.installPlan : undefined;
  const id = plan ? stringValue(plan.id) : undefined;
  const phase = plan ? stringValue(plan.phase) : undefined;
  return isJapaneseCli()
    ? `アプリのインストールを開始しました${id ? `: ${id}` : ""}${phase ? ` (${phase})` : ""}`
    : `App install started${id ? `: ${id}` : ""}${phase ? ` (${phase})` : ""}`;
}

function formatAppUninstall(capsuleId: string, value: unknown, json: boolean): string {
  if (json) return JSON.stringify(value, null, 2);
  const status = isRecord(value) && isRecord(value.capsule)
    ? stringValue(value.capsule.status)
    : undefined;
  return isJapaneseCli()
    ? `アプリ ${capsuleId} のアンインストールを受け付けました${status ? ` (${status})` : ""}`
    : `App ${capsuleId} uninstall accepted${status ? ` (${status})` : ""}`;
}

export function appsHelpText(): string {
  if (isJapaneseCli()) return [
    "takosumi apps <command>", "", "コマンド:",
    "  list                         自分が管理できるアプリを表示",
    "  install --git <url>          Git からアプリをインストール",
    "  uninstall <app-id>           アプリをアンインストール",
    "", "共通オプション: --url、--token（Accounts PAT）、--json",
    "環境変数: TAKOSUMI_ACCOUNT_TOKEN",
  ].join("\n");
  return [
    "takosumi apps <command>", "", "Commands:",
    "  list                         List apps you can manage",
    "  install --git <url>          Install an app from Git",
    "  uninstall <app-id>           Uninstall an app",
    "", "Common options: --url, --token (Accounts PAT), --json",
    "Environment: TAKOSUMI_ACCOUNT_TOKEN",
  ].join("\n");
}

export function appsListHelpText(): string {
  return isJapaneseCli()
    ? ["takosumi apps list", "", "--workspace <id> は旧サーバー用（省略可）", "--url <Takosumi origin> --token <Accounts PAT> --json", "環境変数: TAKOSUMI_ACCOUNT_TOKEN"].join("\n")
    : ["takosumi apps list", "", "Optional: --workspace <id> for older servers", "--url <Takosumi origin> --token <Accounts PAT> --json", "Environment: TAKOSUMI_ACCOUNT_TOKEN"].join("\n");
}

export function appsInstallHelpText(): string {
  const lines = [
    "takosumi apps install --git <url>", "",
    "Options: --ref <ref>, --path <path>, --name <source-name>,",
    "         --app-name <name>, --environment <name>, --workspace <id>",
    "--workspace is used only when an older server returns 404.",
    "--idempotency-key <key> reuses this attempt key for a manual retry.",
    "--url <Takosumi origin> --token <Accounts PAT> --json",
    "Environment: TAKOSUMI_ACCOUNT_TOKEN",
  ];
  if (isJapaneseCli()) return [
    "takosumi apps install --git <url>", "",
    "オプション: --ref <ref>、--path <path>、--name <source-name>,",
    "          --app-name <name>、--environment <name>、--workspace <id>",
    "--workspace は旧サーバーが 404 を返した場合だけ使います。",
    "--idempotency-key <key> は手動再試行で同じ試行キーを使います。",
    "--url <Takosumi origin> --token <Accounts PAT> --json",
    "環境変数: TAKOSUMI_ACCOUNT_TOKEN",
  ].join("\n");
  return lines.join("\n");
}

export function appsUninstallHelpText(): string {
  return isJapaneseCli() ? [
    "takosumi apps uninstall <app-id> --yes",
    "", "--yes で確認し、通常のアンインストール処理を開始します。",
    "--url <Takosumi origin> --token <Accounts PAT> --json",
    "環境変数: TAKOSUMI_ACCOUNT_TOKEN",
  ].join("\n") : [
    "takosumi apps uninstall <app-id> --yes",
    "", "--yes confirms starting the app's normal uninstall process.",
    "--url <Takosumi origin> --token <Accounts PAT> --json",
    "Environment: TAKOSUMI_ACCOUNT_TOKEN",
  ].join("\n");
}

async function collectAppPages(
  firstPage: unknown,
  path: string,
  options: Record<string, string | boolean>,
): Promise<unknown> {
  if (!isRecord(firstPage)) return firstPage;
  const field = Array.isArray(firstPage.apps)
    ? "apps"
    : Array.isArray(firstPage.installedApps)
      ? "installedApps"
      : undefined;
  if (!field) return firstPage;

  const items = [...firstPage[field] as unknown[]];
  const seenCursors = new Set<string>();
  let cursor = stringValue(firstPage.nextCursor);
  while (cursor) {
    if (seenCursors.has(cursor)) {
      throw new Error("Takosumi apps returned a repeated pagination cursor");
    }
    seenCursors.add(cursor);
    const separator = path.includes("?") ? "&" : "?";
    const page = await requestDeployControlApi({
      path: `${path}${separator}cursor=${encodeURIComponent(cursor)}`,
      options,
      auth: "accounts",
    });
    if (!isRecord(page) || !Array.isArray(page[field])) {
      throw new Error("Takosumi apps returned an invalid paginated response");
    }
    items.push(...page[field] as unknown[]);
    cursor = stringValue(page.nextCursor);
  }
  const { nextCursor: _nextCursor, ...result } = firstPage;
  return { ...result, [field]: items };
}
