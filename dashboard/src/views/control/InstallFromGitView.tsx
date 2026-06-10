/**
 * Install from Git flow (spec §31).
 *
 * The official install entry: register a Source from a Git URL, sync it to a
 * snapshot, create an Installation bound to an InstallConfig, then create the
 * first plan Run. The user-facing form fields are Git URL / Ref / Path /
 * target Space / Installation name. InstallConfig, deployment environment, and
 * provider binding details stay internal defaults.
 *
 * The flow runs as four ordered steps, each surfaced so a mid-flow failure is
 * recoverable without restarting from scratch:
 *   1. createSource   -> POST /v1/control/sources
 *   2. syncSource     -> POST /v1/control/sources/:id/sync   (resolves a snapshot)
 *   3. createInstall  -> POST /v1/control/spaces/:id/installations
 *   4. plan           -> POST /v1/control/installations/:id/plan  -> /runs/:id
 *
 * A `source_sync_required` / 409 from createInstallation or plan (the snapshot
 * is not ready yet) is surfaced humanely with a "再同期" retry rather than a raw
 * error code.
 *
 * Deep link: the `/install` external link redirects to
 * `/install?git=<url>&ref=<ref>&path=<path>`. The view also accepts the packed
 * `source=git::<url>//<path>?ref=<ref>` form directly for local previews and
 * keeps the older hash-query reader as a compatibility fallback.
 *
 * Two landing shapes, same flow:
 *   - Arrived from a Git-URL button (prefill present): lead with a plain-Japanese
 *     "<Capsule> を @space に入れます" summary and fold the raw Git URL / Ref /
 *     Path into a 詳細 disclosure, so a non-engineer sees a readable summary +
 *     a single progress button.
 *   - Hand-typed (no prefill): keep the raw Git URL / Ref / Path form up front —
 *     the developer power path is unchanged.
 * Both shapes drive the identical createInstallation / plan flow, compatibility
 * check, and InstallConfig resolution; only copy and disclosure differ.
 */
import {
  createMemo,
  createResource,
  createSignal,
  For,
  onMount,
  Show,
} from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import SpaceSelector from "./SpaceSelector.tsx";
import { currentSpaceId } from "./space-state.ts";
import {
  checkCapsuleCompatibility,
  ControlApiError,
  createInstallation,
  createSource,
  extractRunId,
  type ProviderBindings,
  type CapsuleCompatibilityLevel,
  type CapsuleCompatibilityResult,
  type InstallConfig,
  listConnections,
  listInstallConfigs,
  listSpaces,
  planInstallation,
  putDeploymentProfile,
  syncSource,
  waitForLatestSourceSnapshot,
} from "../../lib/control-api.ts";

/**
 * Reads `git` / `ref` / `path` from the path-route search OR the M9 hash link.
 * This is the generic raw-Git-URL install primitive: a deep link only carries
 * the repo coordinates, and the InstallConfig profile is resolved service-side
 * from the Space's available configs (see `ensureConfigSelected`), never from
 * the URL.
 */
function readPrefill(): {
  git: string;
  ref: string;
  path: string;
} {
  const out = { git: "", ref: "", path: "" };
  if (typeof location === "undefined") return out;
  const apply = (params: URLSearchParams) => {
    const packed = parsePackedInstallSource(params.get("source"));
    out.git = params.get("git") ?? packed?.git ?? out.git;
    out.ref = params.get("ref") ?? packed?.ref ?? out.ref;
    out.path = params.get("path") ?? packed?.path ?? out.path;
  };
  // Path-route form: /install?git=...
  apply(new URLSearchParams(location.search));
  // M9 deep-link form: /#/install?git=... — the query lives after the hash's
  // own "?". location.hash is e.g. "#/install?git=...&ref=...".
  const hash = location.hash;
  const q = hash.indexOf("?");
  if (q !== -1) apply(new URLSearchParams(hash.slice(q + 1)));
  return out;
}

function parsePackedInstallSource(
  source: string | null,
): { git: string; ref: string; path: string } | undefined {
  const prefix = "git::";
  if (!source?.startsWith(prefix)) return undefined;
  const body = source.slice(prefix.length);
  const queryStart = body.indexOf("?");
  const beforeQuery = queryStart === -1 ? body : body.slice(0, queryStart);
  const query = queryStart === -1 ? "" : body.slice(queryStart + 1);
  const marker = findModulePathMarker(beforeQuery);
  const git = marker === -1 ? beforeQuery : beforeQuery.slice(0, marker);
  const path = marker === -1 ? "" : beforeQuery.slice(marker + 2);
  const params = new URLSearchParams(query);
  return {
    git,
    ref: params.get("ref") ?? "",
    path,
  };
}

function findModulePathMarker(value: string): number {
  const scheme = value.indexOf("://");
  const start = scheme === -1 ? 0 : scheme + "://".length;
  return value.indexOf("//", start);
}

type StepState = "idle" | "running" | "done" | "error";
export default function InstallFromGitView() {
  return <Page title="Git から導入">{() => <Inner />}</Page>;
}

function Inner() {
  const navigate = useNavigate();

  const prefill = readPrefill();
  // A deep-link landing (the `/install` redirect from a Git-URL button) carries
  // the repo coordinates in the URL. When that is the case we lead with a plain
  // "<Capsule> を @space に入れる" summary and fold the raw Git URL / Ref / Path
  // fields into a 詳細 disclosure; a hand-typed entry (no prefill) keeps the raw
  // form up front so the developer power path is unchanged.
  const cameFromDeepLink = prefill.git.trim().length > 0;
  const [gitUrl, setGitUrl] = createSignal(prefill.git);
  const [ref, setRef] = createSignal(prefill.ref || "main");
  const [path, setPath] = createSignal(prefill.path || ".");
  const [name, setName] = createSignal("");
  // Resolved from the Space's available InstallConfig profiles once they load
  // (see `ensureConfigSelected`); the URL never carries an InstallConfig id.
  const [installConfigId, setInstallConfigId] = createSignal("");
  const [compatibility, setCompatibility] =
    createSignal<CapsuleCompatibilityResult | null>(null);
  const [checkingCompatibility, setCheckingCompatibility] = createSignal(false);

  // Derive a default Installation name from the repo when not yet typed.
  onMount(() => {
    if (!name() && prefill.git) {
      const guess = prefill.git
        .replace(/\.git$/, "")
        .split("/")
        .filter(Boolean)
        .pop();
      if (guess) setName(guess);
    }
  });

  // A friendly capsule label for the deep-link summary: the repo's last path
  // segment when we can read it, otherwise the raw URL. Display only — identity
  // and install resolution still use the Git URL / Ref / Path verbatim.
  const capsuleDisplayName = () => {
    const url = gitUrl().trim();
    if (!url) return "";
    const guess = url
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean)
      .pop();
    return guess || url;
  };

  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);
  // Resolve the selected Space's @handle for the deep-link summary line. Display
  // only; falls back to the raw id while the list loads.
  const [spaces] = createResource(listSpaces);
  const spaceHandle = () => {
    const id = spaceId();
    if (!id) return "";
    const match = (spaces() ?? []).find((s) => s.id === id);
    return match ? `@${match.handle}` : id;
  };
  const [configs] = createResource(spaceId, listInstallConfigs);
  // Load the Space's connections so we can tell a beginner, BEFORE they run a
  // plan that will fail at apply time, that they still need to connect a cloud
  // provider — and link them straight to /connections. When the list cannot be
  // loaded yet we say nothing (no false "接続がありません").
  const [connections] = createResource(spaceId, listConnections);
  const hasAnyUsableConnection = () => {
    if (connections.loading || connections.error) return true;
    const list = connections.latest;
    if (list === undefined) return true;
    return list.some((connection) => connection.status !== "revoked");
  };

  // Select the first internal OpenTofu Capsule profile once configs load.
  const configList = createMemo<readonly InstallConfig[]>(
    () => configs() ?? [],
  );
  const ensureConfigSelected = () => {
    const list = configList();
    if (list.length === 0) return list;
    const current = installConfigId();
    // Keep the current selection only if the loaded list actually has it;
    // otherwise (empty or an unknown id) fall back to the first available
    // profile so the install button never depends on a stale id.
    if (!current || !list.some((config) => config.id === current)) {
      setInstallConfigId(list[0]!.id);
    }
    return list;
  };
  const selectedInstallConfigId = () => {
    ensureConfigSelected();
    return installConfigId();
  };

  // Step machine state. We keep the created Source id so a retry resumes from
  // the failed step rather than re-creating the Source.
  const [createdSourceId, setCreatedSourceId] = createSignal<string | null>(
    null,
  );
  const [stepSource, setStepSource] = createSignal<StepState>("idle");
  const [stepSync, setStepSync] = createSignal<StepState>("idle");
  const [stepInstall, setStepInstall] = createSignal<StepState>("idle");
  const [stepPlan, setStepPlan] = createSignal<StepState>("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [syncRequired, setSyncRequired] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const validate = (): string | null => {
    if (!spaceId()) return "Space を選択してください。";
    if (!gitUrl().trim()) return "Git URL を入力してください。";
    if (!name().trim()) return "Installation 名を入力してください。";
    if (!selectedInstallConfigId())
      return "OpenTofu Capsule profile がまだ利用できません。";
    return null;
  };

  const deploymentProfileBindings = (): ProviderBindings => [];

  const resetCompatibility = () => {
    setCompatibility(null);
    setError(null);
  };

  // Plain-Japanese label for each compatibility level. The judgement and the
  // level's meaning are unchanged — only the visible wording is localized so a
  // non-engineer who arrived from an install button understands the verdict.
  const compatibilityLabel = (level: CapsuleCompatibilityLevel): string => {
    switch (level) {
      case "ready":
        return "このまま入れられます";
      case "auto_capsulized":
        return "自動調整して入れられます";
      case "needs_patch":
        return "手直しが必要です";
      case "unsupported":
        return "今は入れられません";
    }
  };

  const canContinue = () =>
    compatibility() !== null && compatibility()?.level !== "unsupported";

  const runCompatibilityCheck = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setCheckingCompatibility(true);
    setError(null);
    try {
      const result = await checkCapsuleCompatibility({
        spaceId: spaceId()!,
        gitUrl: gitUrl().trim(),
        ref: ref().trim() || "main",
        path: path().trim() || ".",
        name: name().trim(),
        installConfigId: selectedInstallConfigId(),
      });
      if (result.sourceId) {
        setCreatedSourceId(result.sourceId);
        setStepSource("done");
        setStepSync("done");
      }
      setCompatibility(result);
    } catch (err) {
      const apiError = err instanceof ControlApiError ? err : undefined;
      setError(apiError?.message ?? String(err));
    } finally {
      setCheckingCompatibility(false);
    }
  };

  const runFlow = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!canContinue()) {
      setError("先に「中身を確認」してから進めてください。");
      return;
    }
    setBusy(true);
    setError(null);
    setSyncRequired(false);
    const space = spaceId()!;
    try {
      // Step 1 — create Source (skip if a previous attempt already created it).
      let sourceId = createdSourceId();
      if (!sourceId) {
        setStepSource("running");
        const result = await createSource({
          spaceId: space,
          name: name().trim(),
          url: gitUrl().trim(),
          defaultRef: ref().trim() || "main",
          defaultPath: path().trim() || ".",
        });
        sourceId = result.source.id;
        setCreatedSourceId(sourceId);
        setStepSource("done");
      } else {
        setStepSource("done");
      }

      // Step 2 — sync the Source to resolve an immutable snapshot.
      setStepSync("running");
      await syncSource(sourceId);
      await waitForLatestSourceSnapshot(sourceId);
      setStepSync("done");

      // Step 3 — create the Installation bound to the chosen InstallConfig.
      setStepInstall("running");
      const installation = await createInstallation({
        spaceId: space,
        name: name().trim(),
        environment: "production",
        sourceId,
        installConfigId:
          compatibility()?.installConfigId ?? selectedInstallConfigId(),
      });
      await putDeploymentProfile(installation.id, deploymentProfileBindings());
      setStepInstall("done");

      // Step 4 — create the first plan Run, then jump to the run summary.
      setStepPlan("running");
      const planEnvelope = await planInstallation(installation.id);
      setStepPlan("done");
      const runId = extractRunId(planEnvelope);
      if (runId) {
        navigate(`/runs/${runId}`);
      } else {
        // No run id surfaced — fall back to the Installations list (there is no
        // dedicated control-plane installation detail route in this MVP).
        navigate(`/installations`);
      }
    } catch (err) {
      const apiError = err instanceof ControlApiError ? err : undefined;
      // The snapshot may not be ready immediately after sync; surface a humane
      // "再同期" affordance instead of the raw 409 code.
      if (apiError?.isSourceSyncRequired) {
        setSyncRequired(true);
        setError(
          "ソースの同期がまだ完了していません。 少し待ってから「再試行」してください。",
        );
      } else {
        setError(apiError?.message ?? String(err));
      }
      // Mark the currently-running step as errored.
      if (stepPlan() === "running") setStepPlan("error");
      else if (stepInstall() === "running") setStepInstall("error");
      else if (stepSync() === "running") setStepSync("error");
      else if (stepSource() === "running") setStepSource("error");
    } finally {
      setBusy(false);
    }
  };

  const stepIcon = (s: StepState): string =>
    s === "done" ? "✓" : s === "error" ? "✕" : s === "running" ? "…" : "·";

  return (
    <AppShell>
      <div class="page-header">
        <h1>{cameFromDeepLink ? "アプリを入れる" : "Git から入れる"}</h1>
        <p class="page-sub">
          {cameFromDeepLink
            ? "リンクから飛んできたアプリを、あなたの Space に入れます。中身を確認してから進めます。"
            : "Git URL を入力してアプリの中身を確認し、問題なければあなたの Space に入れます。"}
        </p>
        <div class="page-actions">
          <a href="/installations" class="btn btn-secondary">
            一覧へ
          </a>
        </div>
      </div>

      <SpaceSelector />

      <Show
        when={spaceId()}
        fallback={
          <section class="empty-state">
            <p>導入先の Space を選択してください。</p>
          </section>
        }
      >
        <section class="detail-section">
          <h2>{cameFromDeepLink ? "入れるアプリ" : "OpenTofu Capsule"}</h2>
          <Show when={!hasAnyUsableConnection()}>
            <p class="muted" role="note">
              適用には Cloudflare や AWS などクラウドの接続が必要です。まだ接続が
              ないようです。{" "}
              <A href="/connections" class="link">
                先にクラウドに接続する
              </A>
              （接続のページが開きます）。
            </p>
          </Show>
          <form
            class="install-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (canContinue()) void runFlow();
              else void runCompatibilityCheck();
            }}
          >
            <Show
              when={cameFromDeepLink}
              fallback={
                <>
                  <label class="form-field">
                    Git URL
                    <input
                      type="text"
                      value={gitUrl()}
                      onInput={(e) => {
                        setGitUrl(e.currentTarget.value);
                        resetCompatibility();
                      }}
                      placeholder="https://github.com/owner/repo.git"
                      autocomplete="off"
                      spellcheck={false}
                    />
                  </label>

                  <div class="install-form-row">
                    <label class="form-field">
                      Ref
                      <input
                        type="text"
                        value={ref()}
                        onInput={(e) => {
                          setRef(e.currentTarget.value);
                          resetCompatibility();
                        }}
                        placeholder="main"
                        autocomplete="off"
                        spellcheck={false}
                      />
                    </label>
                    <label class="form-field">
                      Path（モジュールパス）
                      <input
                        type="text"
                        value={path()}
                        onInput={(e) => {
                          setPath(e.currentTarget.value);
                          resetCompatibility();
                        }}
                        placeholder="."
                        autocomplete="off"
                        spellcheck={false}
                      />
                    </label>
                  </div>
                </>
              }
            >
              {/* Deep-link landing: lead with a plain summary, then fold the
                  raw Git URL / Ref / Path into a 詳細 disclosure so a power user
                  can still edit them. Editing keeps the same setters, so the
                  createInstallation / plan path is unchanged. */}
              <div class="compatibility-result">
                <p>
                  <strong>{capsuleDisplayName()}</strong> を{" "}
                  <strong>{spaceHandle()}</strong> に入れます。
                </p>
                <p class="muted">{gitUrl()}</p>
              </div>

              <details class="connection-advanced">
                <summary>詳細（取得元の編集・上級者向け）</summary>
                <label class="form-field">
                  Git URL
                  <input
                    type="text"
                    value={gitUrl()}
                    onInput={(e) => {
                      setGitUrl(e.currentTarget.value);
                      resetCompatibility();
                    }}
                    placeholder="https://github.com/owner/repo.git"
                    autocomplete="off"
                    spellcheck={false}
                  />
                </label>

                <div class="install-form-row">
                  <label class="form-field">
                    Ref
                    <input
                      type="text"
                      value={ref()}
                      onInput={(e) => {
                        setRef(e.currentTarget.value);
                        resetCompatibility();
                      }}
                      placeholder="main"
                      autocomplete="off"
                      spellcheck={false}
                    />
                  </label>
                  <label class="form-field">
                    Path（モジュールパス）
                    <input
                      type="text"
                      value={path()}
                      onInput={(e) => {
                        setPath(e.currentTarget.value);
                        resetCompatibility();
                      }}
                      placeholder="."
                      autocomplete="off"
                      spellcheck={false}
                    />
                  </label>
                </div>
              </details>
            </Show>

            <label class="form-field">
              {cameFromDeepLink ? "この導入の名前" : "Installation 名"}
              <input
                type="text"
                value={name()}
                onInput={(e) => {
                  setName(e.currentTarget.value);
                  resetCompatibility();
                }}
                placeholder="talk"
                autocomplete="off"
                spellcheck={false}
              />
            </label>

            <Show when={!configs.loading && configList().length === 0}>
              <p class="sign-in-error" role="alert">
                OpenTofu Capsule profile が利用できません。
              </p>
            </Show>

            <Show when={compatibility()}>
              {(result) => (
                <section class="compatibility-result">
                  <div class="compatibility-result-head">
                    <h3>{cameFromDeepLink ? "入れられるか" : "Compatibility result"}</h3>
                    <span
                      class={`status-pill compatibility-${result().level.replaceAll("_", "-")}`}
                    >
                      {compatibilityLabel(result().level)}
                    </span>
                  </div>
                  <p>{result().summary}</p>
                  <Show when={result().diagnostics.length > 0}>
                    <ul class="compatibility-diagnostics">
                      <For each={result().diagnostics}>
                        {(diagnostic) => (
                          <li class={`compatibility-${diagnostic.severity}`}>
                            {diagnostic.message}
                            <Show when={diagnostic.detail}>
                              {(detail) => (
                                <span class="muted"> — {detail()}</span>
                              )}
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </section>
              )}
            </Show>

            <div class="form-actions">
              <button
                class="btn btn-secondary"
                type="button"
                disabled={checkingCompatibility() || busy()}
                onClick={() => void runCompatibilityCheck()}
              >
                {checkingCompatibility() ? "確認中..." : "中身を確認"}
              </button>
              <button
                class="btn btn-primary"
                type="submit"
                disabled={busy() || !canContinue()}
              >
                {busy() ? "準備中..." : "確認して入れる"}
              </button>
              <Show when={syncRequired() && !busy()}>
                <button
                  class="btn btn-secondary"
                  type="button"
                  onClick={() => void runFlow()}
                >
                  再試行
                </button>
              </Show>
            </div>

            <Show when={error()}>
              {(m) => <p class="sign-in-error">{m()}</p>}
            </Show>
          </form>

          <Show when={stepSource() !== "idle"} fallback={null}>
            <ol class="install-steps">
              <li classList={{ active: stepSource() === "running" }}>
                <span class="install-step-icon">{stepIcon(stepSource())}</span>
                Source を登録
              </li>
              <li classList={{ active: stepSync() === "running" }}>
                <span class="install-step-icon">{stepIcon(stepSync())}</span>
                Source を同期
              </li>
              <li classList={{ active: stepInstall() === "running" }}>
                <span class="install-step-icon">{stepIcon(stepInstall())}</span>
                OpenTofu Capsule Installation を作成
              </li>
              <li classList={{ active: stepPlan() === "running" }}>
                <span class="install-step-icon">{stepIcon(stepPlan())}</span>
                Plan を実行
              </li>
            </ol>
          </Show>
        </section>
      </Show>
    </AppShell>
  );
}
