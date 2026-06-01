import { Title } from "@solidjs/meta";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { GitBranch, Server } from "lucide-solid";
import { createEffect, createSignal, Show } from "solid-js";
import AppShell from "~/components/shell/AppShell";
import AuthGuard from "~/components/auth/AuthGuard";
import {
  createInstallation,
  dryRunInstallation,
  type InstallationDryRunResponse,
} from "~/lib/api/installations";
import { ApiError } from "~/lib/api/client";
import { readSession } from "~/lib/session";

type Mode = "shared-cell" | "dedicated" | "self-hosted";

export default function Install() {
  return (
    <>
      <Title>Install app — Takosumi</Title>
      <AuthGuard>{() => <Inner />}</AuthGuard>
    </>
  );
}

function Inner() {
  const nav = useNavigate();
  // Pre-fill from URL query (?git=...&ref=...&mode=...&space=...&account=...&autodryrun=1)
  // so product landing pages (takos.jp / yurucommu.com) can deep-link
  // straight into the install wizard with the source already filled in.
  const [params] = useSearchParams<{
    git?: string;
    ref?: string;
    mode?: string;
    space?: string;
    account?: string;
    autodryrun?: string;
  }>();

  const [gitUrl, setGitUrl] = createSignal(params.git ?? "");
  const [ref, setRef] = createSignal(params.ref ?? "main");
  const initialMode =
    params.mode === "dedicated" || params.mode === "self-hosted"
      ? params.mode
      : "shared-cell";
  const [mode, setMode] = createSignal<Mode>(initialMode);
  const [spaceId, setSpaceId] = createSignal(
    params.space ??
      (typeof localStorage !== "undefined"
        ? (localStorage.getItem("tg_apps_space_id") ?? "")
        : ""),
  );
  const [accountId, setAccountId] = createSignal(
    params.account ??
      (typeof localStorage !== "undefined"
        ? (localStorage.getItem("tg_apps_account_id") ?? "")
        : ""),
  );

  const [dryRun, setDryRun] = createSignal<InstallationDryRunResponse | null>(
    null,
  );
  const [dryRunning, setDryRunning] = createSignal(false);
  const [installing, setInstalling] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [autoDryRunFired, setAutoDryRunFired] = createSignal(false);

  const runDryRun = async (e?: Event) => {
    e?.preventDefault();
    setErr(null);
    setDryRun(null);
    setDryRunning(true);
    try {
      const result = await dryRunInstallation({
        gitUrl: gitUrl(),
        ref: ref(),
        spaceId: spaceId(),
      });
      setDryRun(result);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setDryRunning(false);
    }
  };

  // ?autodryrun=1 with a git URL runs dry-run once on mount.
  createEffect(() => {
    if (
      params.autodryrun === "1" &&
      gitUrl() &&
      spaceId() &&
      !autoDryRunFired() &&
      !dryRunning() &&
      !dryRun()
    ) {
      setAutoDryRunFired(true);
      void runDryRun();
    }
  });

  const runInstall = async () => {
    setErr(null);
    const p = dryRun();
    if (!p) {
      setErr("先に dry-run を実行してください。");
      return;
    }
    const session = readSession();
    if (!session) {
      setErr("session が見つかりません。 再ログインしてください。");
      return;
    }
    const appId = pickString(p, [
      "installPlan.repo.id",
      "repo.id",
      "source.repositoryUrl",
      "source.url",
    ]);
    const commit = pickString(p, ["expected.commit", "source.commit"]);
    const planSnapshotDigest = pickString(p, [
      "expected.planSnapshotDigest",
      "planSnapshotDigest",
    ]);
    if (!appId || !commit || !planSnapshotDigest) {
      setErr(
        "Dry-run の結果を install に使用できませんでした。時間をおいて再度お試しください。",
      );
      return;
    }
    setInstalling(true);
    try {
      const created = await createInstallation({
        accountId: accountId(),
        spaceId: spaceId(),
        appId,
        source: {
          gitUrl: gitUrl(),
          ref: ref(),
          commit,
          planSnapshotDigest,
        },
        mode: mode(),
        createdBySubject: session.subject,
      });
      localStorage.setItem("tg_apps_account_id", accountId());
      localStorage.setItem("tg_apps_space_id", spaceId());
      nav(`/apps/${encodeURIComponent(created.installationId)}`);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <AppShell>
      <div class="page-header">
        <h1>App を install</h1>
        <p class="page-sub">
          Git リポジトリから takosumi 上に app を install します。
        </p>
      </div>

      <section class="detail-section">
        <h2>Source</h2>
        <form class="install-form" onSubmit={runDryRun}>
          <label>
            Git URL
            <input
              type="url"
              value={gitUrl()}
              onInput={(e) => setGitUrl(e.currentTarget.value)}
              placeholder="https://github.com/owner/repo.git"
              required
            />
          </label>
          <label>
            Ref
            <input
              type="text"
              value={ref()}
              onInput={(e) => setRef(e.currentTarget.value)}
              placeholder="main"
              required
            />
          </label>
          <button
            class="btn btn-secondary"
            type="submit"
            disabled={dryRunning() || !gitUrl() || !spaceId()}
          >
            <GitBranch size={16} /> {dryRunning() ? "Dry-run 中..." : "Dry run"}
          </button>
        </form>
      </section>

      <Show when={dryRun()}>
        {(p) => (
          <section class="detail-section">
            <h2>Dry-run 結果</h2>
            <dl class="kv-list">
              <dt>App ID</dt>
              <dd>
                {pickString(p(), [
                  "installPlan.repo.id",
                  "repo.id",
                  "source.repositoryUrl",
                  "source.url",
                ]) ?? "—"}
              </dd>
              <dt>Commit</dt>
              <dd>
                <code>
                  {pickString(p(), [
                    "source.commit",
                    "expected.commit",
                  ]) ?? "—"}
                </code>
              </dd>
              <dt>Plan snapshot digest</dt>
              <dd>
                <code>
                  {pickString(p(), [
                    "planSnapshotDigest",
                  ]) ?? "—"}
                </code>
              </dd>
              <dt>Expected plan digest</dt>
              <dd>
                <code>
                  {pickString(p(), [
                    "expected.planSnapshotDigest",
                  ]) ?? "—"}
                </code>
              </dd>
            </dl>
          </section>
        )}
      </Show>

      <section class="detail-section">
        <h2>Target</h2>
        <div class="install-grid">
          <label>
            Account ID
            <input
              type="text"
              value={accountId()}
              onInput={(e) => setAccountId(e.currentTarget.value)}
              placeholder="acct_xxxxx"
            />
          </label>
          <label>
            Space ID
            <input
              type="text"
              value={spaceId()}
              onInput={(e) => setSpaceId(e.currentTarget.value)}
              placeholder="space_xxxxx"
            />
          </label>
          <label>
            Mode
            <select
              value={mode()}
              onChange={(e) => setMode(e.currentTarget.value as Mode)}
            >
              <option value="shared-cell">shared-cell</option>
              <option value="dedicated">dedicated</option>
              <option value="self-hosted">self-hosted</option>
            </select>
          </label>
        </div>
      </section>

      <Show when={err()}>{(m) => <p class="sign-in-error">{m()}</p>}</Show>

      <section class="detail-section">
        <button
          class="btn btn-primary"
          type="button"
          onClick={runInstall}
          disabled={installing() || !dryRun() || !accountId() || !spaceId()}
        >
          <Server size={16} /> {installing() ? "Install 中..." : "Install"}
        </button>
        <a href="/apps" class="btn btn-secondary" style="margin-left: 8px;">
          キャンセル
        </a>
        <p class="muted" style="margin-top: 12px;">
          Install 先の account と space を確認してから実行してください。
        </p>
      </section>
    </AppShell>
  );
}

function pickString(
  obj: Record<string, unknown>,
  paths: string[],
): string | null {
  for (const p of paths) {
    const v = lookupPath(obj, p);
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function lookupPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (
      cur &&
      typeof cur === "object" &&
      k in (cur as Record<string, unknown>)
    ) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}
