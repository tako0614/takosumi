import { useNavigate, useSearchParams } from "@solidjs/router";
import { GitBranch, Server } from "lucide-solid";
import { createEffect, createSignal, Show } from "solid-js";
import AppShell from "~/components/shell/AppShell";
import { ApiError, type InstallationPlanRunResponse, rpc } from "~/lib/rpc";
import { readSession } from "~/lib/session";

type Mode = "shared-cell" | "dedicated" | "self-hosted";

/**
 * The install-by-URL wizard. Shared by the canonical `/install` route and the
 * in-dashboard `/apps/install` route. Pre-fills from URL query
 * (?git=...&ref=...&mode=...&space=...&account=...&autoplan=1) so product
 * landing pages (takos.jp / yurucommu.com) can deep-link straight into install
 * with the source already filled in, and `autoplan=1` runs the PlanRun on mount.
 */
export default function InstallWizard() {
  const nav = useNavigate();
  const [params] = useSearchParams<{
    git?: string;
    ref?: string;
    mode?: string;
    space?: string;
    account?: string;
    autoplan?: string;
  }>();

  const [gitUrl, setGitUrl] = createSignal(params.git ?? "");
  const [ref, setRef] = createSignal(params.ref ?? "main");
  const initialMode =
    params.mode === "dedicated" || params.mode === "self-hosted"
      ? params.mode
      : "shared-cell";
  const [mode, setMode] = createSignal<Mode>(initialMode);
  // New-user one-click install: fall back to the session's primary account and
  // a freshly generated space so `autoplan` can fire and Plan/Install enable
  // even for a cold visitor who has no account/space yet. The install create
  // bootstraps the LedgerAccount + Space from these ids; the server allows a
  // PlanRun against a not-yet-created space. Fields stay editable for users
  // targeting an existing account/space (their last-used ids are restored
  // from localStorage).
  const [spaceId, setSpaceId] = createSignal(
    params.space ?? storedValue("tg_apps_space_id") ?? generatedId("space"),
  );
  const [accountId, setAccountId] = createSignal(
    params.account ?? storedValue("tg_apps_account_id") ??
      readSession()?.primaryAccountId ?? generatedId("acct"),
  );

  const [planRun, setPlanRun] = createSignal<InstallationPlanRunResponse | null>(
    null,
  );
  const [planRunning, setPlanRunning] = createSignal(false);
  const [installing, setInstalling] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [autoPlanFired, setAutoPlanFired] = createSignal(false);

  const runPlanRun = async (e?: Event) => {
    e?.preventDefault();
    setErr(null);
    setPlanRun(null);
    setPlanRunning(true);
    try {
      const result = await rpc.installations.plan({
        gitUrl: gitUrl(),
        ref: ref(),
        spaceId: spaceId(),
      });
      setPlanRun(result);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setPlanRunning(false);
    }
  };

  // ?autoplan=1 with a git URL runs PlanRun once on mount.
  createEffect(() => {
    if (
      params.autoplan === "1" &&
      gitUrl() &&
      spaceId() &&
      !autoPlanFired() &&
      !planRunning() &&
      !planRun()
    ) {
      setAutoPlanFired(true);
      void runPlanRun();
    }
  });

  const runInstall = async () => {
    setErr(null);
    const p = planRun();
    if (!p) {
      setErr("先に PlanRun を実行してください。");
      return;
    }
    const session = readSession();
    if (!session) {
      setErr("session が見つかりません。 再ログインしてください。");
      return;
    }
    const appId = pickString(p, [
      "repo.id",
      "source.repositoryUrl",
      "source.url",
    ]);
    const commit = pickString(p, ["expected.sourceCommit", "source.commit"]);
    const planDigest = pickString(p, [
      "expected.planDigest",
      "planDigest",
    ]);
    if (!appId || !commit || !planDigest) {
      setErr(
        "Plan の結果を install に使用できませんでした。時間をおいて再度お試しください。",
      );
      return;
    }
    setInstalling(true);
    try {
      const created = await rpc.installations.create({
        accountId: accountId(),
        spaceId: spaceId(),
        appId,
        source: {
          gitUrl: gitUrl(),
          ref: ref(),
          commit,
          planDigest,
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
        <form class="install-form" onSubmit={runPlanRun}>
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
            disabled={planRunning() || !gitUrl() || !spaceId()}
          >
            <GitBranch size={16} /> {planRunning() ? "Plan 中..." : "Plan"}
          </button>
        </form>
      </section>

      <Show when={planRun()}>
        {(p) => (
          <section class="detail-section">
            <h2>Plan 結果</h2>
            <dl class="kv-list">
              <dt>App ID</dt>
              <dd>
                {pickString(p(), [
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
                    "expected.sourceCommit",
                  ]) ?? "—"}
                </code>
              </dd>
              <dt>Plan digest digest</dt>
              <dd>
                <code>
                  {pickString(p(), [
                    "planDigest",
                  ]) ?? "—"}
                </code>
              </dd>
              <dt>Expected plan digest</dt>
              <dd>
                <code>
                  {pickString(p(), [
                    "expected.planDigest",
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
          disabled={installing() || !planRun() || !accountId() || !spaceId()}
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

function storedValue(key: string): string | undefined {
  if (typeof localStorage === "undefined") return undefined;
  const value = localStorage.getItem(key);
  return value && value.length > 0 ? value : undefined;
}

function generatedId(prefix: "space" | "acct"): string {
  return `${prefix}_${crypto.randomUUID()}`;
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
