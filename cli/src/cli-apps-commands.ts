import { randomUUID } from "node:crypto";
import type { GitInstallPlanPhase } from "takosumi-contract/install-plans";
import { isJapaneseCli } from "./cli-help.ts";
import type { CliIo } from "./cli-io.ts";
import { booleanOption, optionalStringOption, parseOptions } from "./cli-options.ts";
import {
  DeployControlApiError,
  requestDeployControlApi,
} from "./cli-deploy-control-api.ts";
import { isRecord, stringValue } from "./cli-util.ts";
import { runAppUpdate, runAppRollback, runAppHistory, runAppApply, runAppRecoverUninstall } from "./cli-app-update-commands.ts";

const APPS_PATH = "/api/v1/apps";
const INSTALL_PLANS_PATH = "/api/v1/install-plans";
const installPlanPhases = {
  syncing_source: true,
  compiling_install: true,
  analyzing_compatibility: true,
  awaiting_input: true,
  creating_capsule: true,
  planning: true,
  reviewable: true,
  failed: true,
  discarded: true,
} satisfies Record<GitInstallPlanPhase, true>;

function isMissingAppRoute(error: unknown, allowUnclassified = false): error is DeployControlApiError {
  const bodyError = error instanceof DeployControlApiError && isRecord(error.body)
    ? error.body.error
    : undefined;
  const hasOnlyRouteEnvelopeFields = isRecord(bodyError) &&
    Object.keys(bodyError).every((key) => ["code", "message", "requestId"].includes(key));
  const isDocumentedRouteNotFound = isRecord(bodyError) && bodyError.code === "not_found" &&
    bodyError.message === "not found" && typeof bodyError.requestId === "string" &&
    hasOnlyRouteEnvelopeFields;
  const isCodeOnlyRouteNotFound = isRecord(bodyError) && bodyError.code === "not_found" &&
    !stringValue(bodyError.message) && hasOnlyRouteEnvelopeFields;

  return error instanceof DeployControlApiError && error.status === 404 &&
    ((error.code === undefined && (allowUnclassified || error.plainRouteMissing)) ||
      error.code === "route_not_found" || error.code === "fixture_route_not_found" ||
      (error.code === "not_found" && isRecord(error.body) && (
        error.body.error === "not_found" ||
        isCodeOnlyRouteNotFound || isDocumentedRouteNotFound
      )));
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
  if (command === "recover-uninstall") return await runAppRecoverUninstall(rest, io);
  if (command === "update") return await runAppUpdate(rest, io);
  if (command === "history") return await runAppHistory(rest, io);
  if (command === "rollback") return await runAppRollback(rest, io);
  if (command === "apply") return await runAppApply(rest, io);
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
      if (!isMissingAppRoute(error, true) || !workspaceId) {
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
  const resumeLegacyWorkspaceId = optionalStringOption(options, "resumeLegacyWorkspace");
  if (options.resumeLegacyWorkspace !== undefined &&
      (!resumeLegacyWorkspaceId || options.workspace !== undefined || typeof requestedIdempotencyKey !== "string")) {
    io.stderr(isJapaneseCli()
      ? "--resume-legacy-workspace <id> には保存済みの --idempotency-key が必要です。--workspace は省略してください。"
      : "Pass a saved --idempotency-key with --resume-legacy-workspace <id> and omit --workspace.");
    return 2;
  }
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
  let legacyAttemptWorkspaceId = resumeLegacyWorkspaceId;
  const post = () => {
    if (legacyAttemptWorkspaceId) {
      io.stderr(JSON.stringify({ kind: "install_attempt_legacy_workspace", workspaceId: legacyAttemptWorkspaceId }));
    }
    return requestDeployControlApi({
      path: legacyAttemptWorkspaceId
        ? `/api/v1/workspaces/${encodeURIComponent(legacyAttemptWorkspaceId)}/install-plans`
        : INSTALL_PLANS_PATH,
      method: "POST",
      body,
      options,
      auth: "accounts",
      extraHeaders: attemptHeaders,
      redirect: "error",
    });
  };
  try {
    // Retain this before dispatch: a lost create response must not strand the
    // generated key. It is an intent reference, not proof of acceptance.
    io.stderr(JSON.stringify({ kind: "install_attempt_key", idempotencyKey }));
    let response: unknown;
    try {
      response = await post();
    } catch (error) {
      if (legacyAttemptWorkspaceId || !isMissingAppRoute(error)) throw error;
      if (!workspaceId) {
        io.stderr(isJapaneseCli()
          ? "このサーバーはワークスペースなしのアプリインストールに対応していません。サーバーを更新するか、旧サーバーとの互換利用で --workspace を指定してください。"
          : "Workspace-less app install is not available on this server; update the server or pass --workspace for legacy compatibility.");
        return 1;
      }
      legacyAttemptWorkspaceId = workspaceId;
      response = await post();
    }
    io.stdout(formatAppInstall(response, booleanOption(options, "json")));
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    if (!(error instanceof DeployControlApiError) || error.status >= 500 ||
        (error.status === 404 && error.code === undefined)) {
      io.stderr(isJapaneseCli()
        ? "導入の受付を確認できませんでした。同じ接続先・Accounts ID・要求で、出力された試行キーを --idempotency-key に指定して再実行してください。"
        : "Install acceptance is unconfirmed. Retry with the same server, Accounts identity, and request, using the printed attempt key as --idempotency-key.");
      if (legacyAttemptWorkspaceId) {
        io.stderr(isJapaneseCli()
          ? "旧経路の試行を復旧するには、--workspace の代わりに --resume-legacy-workspace と出力された Workspace ID を指定してください。"
          : "To recover an attempt sent to a legacy Workspace, replace --workspace with --resume-legacy-workspace and the printed Workspace ID.");
      }
    }
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
  const statusOnly = options.status === true;
  if (options.status !== undefined && (!statusOnly || options.yes !== undefined)) {
    io.stderr(isJapaneseCli()
      ? "--status は値と --yes を指定せずに使ってください。"
      : "Pass --status without a value or --yes.");
    return 2;
  }
  if (!statusOnly && !booleanOption(options, "yes")) {
    io.stderr(isJapaneseCli()
      ? `アプリ ${capsuleId} のアンインストールを開始するには --yes を指定してください。`
      : `Pass --yes to confirm uninstalling app ${capsuleId}.`);
    return 2;
  }
  const json = booleanOption(options, "json");
  try {
    const path = `/api/v1/capsules/${encodeURIComponent(capsuleId)}`;
    if (statusOnly) {
      const response = await requestDeployControlApi({ path, options, auth: "accounts", redirect: "error" });
      io.stdout(formatAppUninstallStatus(capsuleId, response, json));
      return 0;
    }
    const response = await requestDeployControlApi({
      path: `${path}/uninstall`,
      method: "POST",
      body: {},
      options,
      auth: "accounts",
      redirect: "error",
    });
    io.stdout(formatAppUninstall(capsuleId, response, json));
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    if (!statusOnly && (!(error instanceof DeployControlApiError) || error.status >= 500)) {
      io.stderr(isJapaneseCli()
        ? "予約の受付を確認できませんでした。同じ接続先・アプリ・Accounts IDで `apps uninstall <app-id> --status` を実行し、現在の予約を確認してください。"
        : "The reservation is unconfirmed. Use `apps uninstall <app-id> --status` with the same server, app and Accounts identity to read the current reservation.");
    }
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
  const language = isJapaneseCli() ? "ja" : "en";
  if (apps.length === 0) return language === "ja" ? "アプリはありません" : "No apps";
  return apps.map((entry) => {
    if (!isRecord(entry)) return JSON.stringify(entry);
    const id = stringValue(entry.capsuleId) ?? stringValue(entry.id) ?? "?";
    const label = entry.displayName;
    const localized = isRecord(label) ? stringValue(label[language]) : undefined;
    const displayName = localized && !/\p{Cc}/u.test(localized) ? localized : stringValue(label);
    const name = displayName ?? stringValue(entry.name) ?? id;
    const state = stringValue(entry.state) ?? "unknown";
    return `${name} (${id}) — ${state}`;
  }).join("\n");
}

function formatAppInstall(value: unknown, json: boolean): string {
  const plan = isRecord(value) && isRecord(value.installPlan) ? value.installPlan : undefined;
  const id = plan?.id;
  const phase = plan?.phase;
  if (typeof id !== "string" || /^[A-Za-z0-9_-]{1,256}$/u.exec(id)?.[0] !== id ||
      typeof phase !== "string" || !Object.hasOwn(installPlanPhases, phase) ||
      (plan?.operation !== undefined && plan.operation !== "install") ||
      (plan?.mode !== undefined && plan.mode !== "attempt")) {
    throw new Error(isJapaneseCli()
      ? "接続先から有効な導入の試行を確認できませんでした。"
      : "The server did not confirm an install attempt.");
  }
  if (json) return JSON.stringify(value, null, 2);
  return isJapaneseCli()
    ? `アプリの導入試行: ${id} (${phase})`
    : `App install attempt: ${id} (${phase})`;
}

function formatAppUninstall(capsuleId: string, value: unknown, json: boolean): string {
  const { status, uninstall } = readAppUninstallStatus(capsuleId, value);
  const alreadyDeleted = isRecord(value) && value.alreadyDeleted === true;
  if (alreadyDeleted ? status !== "destroyed"
    : status !== "uninstalled" || !uninstall || uninstall.phase === "cancelled") {
    throw new Error(appUninstallStatusUnconfirmed());
  }
  if (json) return JSON.stringify(value, null, 2);
  if (alreadyDeleted) {
    return isJapaneseCli()
      ? `アプリ ${capsuleId} は既にアンインストールされています。`
      : `App ${capsuleId} is already uninstalled.`;
  }
  return isJapaneseCli()
    ? `アプリ ${capsuleId} のアンインストールを受け付けました (${status})`
    : `App ${capsuleId} uninstall accepted (${status})`;
}

function appUninstallStatusUnconfirmed(): string {
  return isJapaneseCli() ? "アプリの予約状態を確認できませんでした。" : "Unable to confirm the app's reservation status.";
}

function readAppUninstallStatus(capsuleId: string, value: unknown) {
  const capsule = isRecord(value) ? value.capsule : undefined;
  if (!isRecord(capsule) || capsule.id !== capsuleId || typeof capsule.status !== "string" ||
    !["pending", "active", "stale", "error", "disabled", "uninstalled", "destroyed"].includes(capsule.status)) {
    throw new Error(appUninstallStatusUnconfirmed());
  }

  let uninstall = null;
  if (capsule.uninstall !== undefined) {
    if (!isRecord(capsule.uninstall)) throw new Error(appUninstallStatusUnconfirmed());
    const { id, phase, requestedAt, scheduledDestroyAt } = capsule.uninstall;
    if (typeof id !== "string" || /^[A-Za-z0-9_-]{1,256}$/u.exec(id)?.[0] !== id ||
      (phase !== "scheduled" && phase !== "destroying" && phase !== "cancelled") ||
      typeof requestedAt !== "string" || !Number.isFinite(Date.parse(requestedAt)) ||
      typeof scheduledDestroyAt !== "string" || !Number.isFinite(Date.parse(scheduledDestroyAt))) {
      throw new Error(appUninstallStatusUnconfirmed());
    }
    uninstall = { id, phase, requestedAt, scheduledDestroyAt };
  }
  return { capsuleId, status: capsule.status, uninstall };
}

function formatAppUninstallStatus(capsuleId: string, value: unknown, json: boolean): string {
  const receipt = readAppUninstallStatus(capsuleId, value);
  if (json) return JSON.stringify(receipt, null, 2);
  const { status, uninstall } = receipt;
  const summary = `${capsuleId} — ${status}`;
  if (!uninstall) return `${summary}\n${isJapaneseCli() ? "保存済みの削除予約はありません。" : "No saved uninstall reservation."}`;
  return `${summary}\n${uninstall.id} — ${uninstall.phase} (${new Date(uninstall.scheduledDestroyAt).toISOString()})`;
}

export function appsHelpText(): string {
  if (isJapaneseCli()) return [
    "takosumi apps <command>", "", "コマンド:",
    "  list                         自分が管理できるアプリを表示",
    "  install --git <url>          Git からアプリをインストール",
    "  uninstall <app-id>           アプリをアンインストール",
    "  recover-uninstall <app-id>   代替接続を使う削除Planを準備、または保存Planを確認",
    "  update <app-id>              Git更新のPlanを準備、または保存済みの更新を続行",
    "  history <app-id>             保存済みの状態バージョンを表示",
    "  rollback <app-id>            指定した状態バージョンへの復旧Planを準備、または保存Planを確認",
    "  apply <app-id>               保存Planを明示実行、又は --observe-only で読取",
    "", "共通オプション: --url、--token（Accounts PAT）、--json",
    "環境変数: TAKOSUMI_ACCOUNT_TOKEN",
  ].join("\n");
  return [
    "takosumi apps <command>", "", "Commands:",
    "  list                         List apps you can manage",
    "  install --git <url>          Install an app from Git",
    "  uninstall <app-id>           Uninstall an app",
    "  recover-uninstall <app-id>   Prepare or review an uninstall recovery Plan",
    "  update <app-id>              Prepare a Git update Plan or continue an existing update",
    "  history <app-id>             List saved StateVersions",
    "  rollback <app-id>            Prepare or review a rollback Plan for a saved StateVersion",
    "  apply <app-id>               Execute a saved Plan or read with --observe-only",
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
    "--resume-legacy-workspace <id> reuses the saved legacy route with --idempotency-key.",
    "The key is printed as JSON to stderr before sending; retain it with the same request.",
    "--url <Takosumi origin> --token <Accounts PAT> --json",
    "Environment: TAKOSUMI_ACCOUNT_TOKEN",
  ];
  if (isJapaneseCli()) return [
    "takosumi apps install --git <url>", "",
    "オプション: --ref <ref>、--path <path>、--name <source-name>,",
    "          --app-name <name>、--environment <name>、--workspace <id>",
    "--workspace は旧サーバーが 404 を返した場合だけ使います。",
    "--idempotency-key <key> は手動再試行で同じ試行キーを使います。",
    "--resume-legacy-workspace <id> は --idempotency-key とともに保存済みの旧経路を使います。",
    "送信前にキーを標準エラーへJSONで出力します。同じ要求と一緒に保持してください。",
    "--url <Takosumi origin> --token <Accounts PAT> --json",
    "環境変数: TAKOSUMI_ACCOUNT_TOKEN",
  ].join("\n");
  return lines.join("\n");
}

export function appsUninstallHelpText(): string {
  return isJapaneseCli() ? [
    "takosumi apps uninstall <app-id> --yes",
    "takosumi apps uninstall <app-id> --status",
    "", "--yes で確認し、通常のアンインストール処理を開始します。",
    "--status は現在のアプリ状態と保存済みの削除予約を読み取ります。",
    "--url <Takosumi origin> --token <Accounts PAT> --json",
    "環境変数: TAKOSUMI_ACCOUNT_TOKEN",
  ].join("\n") : [
    "takosumi apps uninstall <app-id> --yes",
    "takosumi apps uninstall <app-id> --status",
    "", "--yes confirms starting the app's normal uninstall process.",
    "--status reads the current app state and saved uninstall reservation.",
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
