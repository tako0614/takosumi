/**
 * Install from Git flow (spec §31).
 *
 * The official install entry: register a Source from a Git URL, sync it to a
 * snapshot, create an Installation bound to an InstallConfig, then create the
 * first plan Run. The form fields are Git URL / Ref / Path / target Space /
 * Installation name / Environment / Mode (InstallConfig from
 * `GET /v1/control/install-configs`).
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
 * Deep link: the M9 `/install` external link redirects to
 * `/#/install?git=<url>&ref=<ref>&path=<path>`. This view also lives at the path
 * route `/install`, so it reads the prefill params from BOTH `location.search`
 * (path route) and the hash fragment (`#/install?...`, what M9 mints), since the
 * dashboard router is path-based and never sees the hash query.
 */
import {
  createMemo,
  createResource,
  createSignal,
  For,
  onMount,
  Show,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import SpaceSelector from "./SpaceSelector.tsx";
import { currentSpaceId, setCurrentSpaceId } from "./space-state.ts";
import {
  ControlApiError,
  createInstallation,
  createSource,
  extractRunId,
  type InstallConfig,
  listInstallConfigs,
  planInstallation,
  syncSource,
} from "../../lib/control-api.ts";

/** Reads `git` / `ref` / `path` from the path-route search OR the M9 hash link. */
function readPrefill(): { git: string; ref: string; path: string } {
  const out = { git: "", ref: "", path: "" };
  if (typeof location === "undefined") return out;
  const apply = (params: URLSearchParams) => {
    out.git = params.get("git") ?? out.git;
    out.ref = params.get("ref") ?? out.ref;
    out.path = params.get("path") ?? out.path;
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

type StepState = "idle" | "running" | "done" | "error";

export default function InstallFromGitView() {
  return <Page title="Git から導入">{() => <Inner />}</Page>;
}

function Inner() {
  const navigate = useNavigate();

  const prefill = readPrefill();
  const [gitUrl, setGitUrl] = createSignal(prefill.git);
  const [ref, setRef] = createSignal(prefill.ref || "main");
  const [path, setPath] = createSignal(prefill.path || ".");
  const [name, setName] = createSignal("");
  const [environment, setEnvironment] = createSignal("production");
  const [installConfigId, setInstallConfigId] = createSignal("");

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

  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);
  const [configs] = createResource(spaceId, listInstallConfigs);

  // Default the mode select to the first config once configs load.
  const configList = createMemo<readonly InstallConfig[]>(() => configs() ?? []);
  const ensureConfigSelected = () => {
    const list = configList();
    if (!installConfigId() && list.length > 0) setInstallConfigId(list[0]!.id);
    return list;
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
    if (!environment().trim()) return "Environment を入力してください。";
    if (!installConfigId()) return "Mode（InstallConfig）を選択してください。";
    return null;
  };

  const runFlow = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
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
      setStepSync("done");

      // Step 3 — create the Installation bound to the chosen InstallConfig.
      setStepInstall("running");
      const installation = await createInstallation({
        spaceId: space,
        name: name().trim(),
        environment: environment().trim(),
        sourceId,
        installConfigId: installConfigId(),
      });
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
        <h1>Git から導入</h1>
        <p class="page-sub">
          Git URL から Source を登録し、 同期して Installation を作成、
          最初の Plan を実行します。
        </p>
        <div class="page-actions">
          <a href="/installations" class="btn btn-secondary">一覧へ</a>
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
          <h2>Installation を作成</h2>
          <form
            class="install-form"
            onSubmit={(e) => {
              e.preventDefault();
              void runFlow();
            }}
          >
            <label class="form-field">
              Git URL
              <input
                type="text"
                value={gitUrl()}
                onInput={(e) => setGitUrl(e.currentTarget.value)}
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
                  onInput={(e) => setRef(e.currentTarget.value)}
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
                  onInput={(e) => setPath(e.currentTarget.value)}
                  placeholder="."
                  autocomplete="off"
                  spellcheck={false}
                />
              </label>
            </div>

            <div class="install-form-row">
              <label class="form-field">
                Installation 名
                <input
                  type="text"
                  value={name()}
                  onInput={(e) => setName(e.currentTarget.value)}
                  placeholder="talk"
                  autocomplete="off"
                  spellcheck={false}
                />
              </label>
              <label class="form-field">
                Environment
                <input
                  type="text"
                  value={environment()}
                  onInput={(e) => setEnvironment(e.currentTarget.value)}
                  placeholder="production"
                  autocomplete="off"
                  spellcheck={false}
                />
              </label>
            </div>

            <label class="form-field">
              Mode（InstallConfig）
              <Show
                when={configList().length > 0}
                fallback={
                  <select disabled>
                    <option>
                      {configs.loading
                        ? "読み込み中..."
                        : "利用可能な InstallConfig がありません"}
                    </option>
                  </select>
                }
              >
                <select
                  value={installConfigId()}
                  onChange={(e) => setInstallConfigId(e.currentTarget.value)}
                >
                  <For each={ensureConfigSelected()}>
                    {(config) => (
                      <option value={config.id}>
                        {config.name} — {config.installType}（{config.trustLevel}）
                        {config.spaceId === undefined ? " · 公式" : ""}
                      </option>
                    )}
                  </For>
                </select>
              </Show>
            </label>

            <div class="form-actions">
              <button class="btn btn-primary" type="submit" disabled={busy()}>
                {busy() ? "実行中..." : "導入して Plan を実行"}
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

          <Show
            when={stepSource() !== "idle"}
            fallback={null}
          >
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
                Installation を作成
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
