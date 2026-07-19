import { createSignal, For, Show } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import {
  capsuleSourceOptionInstallSearch,
  parseCapsuleSourceOptionsInstallLink,
  parseCapsuleSourceOptionsText,
  type CapsuleSourceOption,
  type CapsuleSourceOptions,
} from "takosumi-contract";
import Page from "../account/components/auth/Page.tsx";
import PageHeader from "../../components/ui/PageHeader.tsx";
import { Button, Card, Spinner } from "../../components/ui/index.ts";
import {
  createSource,
  extractRunId,
  readSourceSnapshotPresentationFile,
  resolveStableSourceTag,
  syncSource,
  waitForLatestSourceSnapshot,
} from "../../lib/control-api.ts";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";

interface LoadedOptions {
  readonly document: CapsuleSourceOptions;
  readonly source: {
    readonly url: string;
    readonly requestedRef?: string;
    readonly resolvedTag?: string;
    readonly commit: string;
    readonly path: string;
  };
  readonly digest: string;
  readonly sizeBytes: number;
}

export default function CapsuleSourceOptionsInstallView() {
  return <Page title="追加元を選択">{() => <Inner />}</Page>;
}

function Inner() {
  const location = useLocation();
  const navigate = useNavigate();
  const selector = () => parseCapsuleSourceOptionsInstallLink(location.search);
  const [loaded, setLoaded] = createSignal<LoadedOptions>();
  const [loading, setLoading] = createSignal(false);
  const [selectingId, setSelectingId] = createSignal<string>();
  const [error, setError] = createSignal<string>();

  const load = async () => {
    const selected = selector();
    const workspaceId = currentWorkspaceId();
    if (!selected) {
      setError("CapsuleSourceOptions の install link が無効です");
      return;
    }
    if (!workspaceId) {
      setError("確認する前に Workspace を選択してください");
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const resolved = selected.ref
        ? undefined
        : await resolveStableSourceTag(workspaceId, selected.git);
      const exactRef = selected.ref ?? resolved!.commit;
      const created = await createSource({
        workspaceId,
        name: `options-${crypto.randomUUID().slice(0, 8)}`,
        url: selected.git,
        defaultRef: exactRef,
        defaultPath: ".",
        autoSync: false,
      });
      const sync = await syncSource(created.source.id);
      const snapshot = await waitForLatestSourceSnapshot(created.source.id, {
        runId: extractRunId(sync),
      });
      if (resolved && snapshot.resolvedCommit !== resolved.commit) {
        throw new Error(
          "stable tag の commit と SourceSnapshot が一致しません",
        );
      }
      const file = await readSourceSnapshotPresentationFile(
        created.source.id,
        snapshot.id,
        selected.path,
      );
      const parsed = parseCapsuleSourceOptionsText(file.text);
      if (!parsed.ok) throw new Error(parsed.error);
      setLoaded({
        document: parsed.document,
        source: {
          url: selected.git,
          ...(selected.ref ? { requestedRef: selected.ref } : {}),
          ...(resolved ? { resolvedTag: resolved.tag } : {}),
          commit: snapshot.resolvedCommit,
          path: selected.path,
        },
        digest: file.digest,
        sizeBytes: file.sizeBytes,
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "CapsuleSourceOptions を読み込めませんでした",
      );
    } finally {
      setLoading(false);
    }
  };

  const choose = async (option: CapsuleSourceOption) => {
    const workspaceId = currentWorkspaceId();
    if (!workspaceId) return;
    setSelectingId(option.id);
    setError(undefined);
    try {
      const resolved = option.source.ref
        ? undefined
        : await resolveStableSourceTag(workspaceId, option.source.url);
      navigate(
        `/new${capsuleSourceOptionInstallSearch(option, resolved?.commit)}`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "stable tag を解決できませんでした",
      );
      setSelectingId(undefined);
    }
  };

  return (
    <div class="new-app-view">
      <PageHeader
        title="追加元を選択"
        subtitle="ここでは候補を選ぶだけです。追加・接続・Plan は通常の確認画面で行います。"
      />
      <Show
        when={!loading()}
        fallback={
          <div class="wb-status-panel" role="status">
            <Spinner size={18} /> Git SourceSnapshot から選択肢を確認しています…
          </div>
        }
      >
        <Show when={error()}>
          <div class="wb-status-panel is-error" role="alert">
            {error()}
          </div>
        </Show>
        <Show
          when={loaded()}
          fallback={
            <Card>
              <p>
                公開 Git の明示 ref、または最も新しい stable SemVer tag を
                immutable commit に固定してから文書を読みます。
              </p>
              <Button
                type="button"
                variant="primary"
                onClick={() => void load()}
              >
                選択肢を確認
              </Button>
            </Card>
          }
        >
          {(value) => (
            <section class="new-card-stack" aria-label="Capsule source options">
              <Card>
                <h2>{value().document.metadata.title}</h2>
                <Show when={value().document.metadata.description}>
                  <p>{value().document.metadata.description}</p>
                </Show>
                <p class="wb-note">source: {value().source.url}</p>
                <p class="wb-note">
                  ref:{" "}
                  {value().source.requestedRef ?? value().source.resolvedTag}
                </p>
                <p class="wb-note">commit: {value().source.commit}</p>
                <p class="wb-note">file: {value().source.path}</p>
                <p class="wb-note">
                  exact bytes: {value().digest} ({value().sizeBytes} bytes)
                </p>
              </Card>
              <For each={value().document.options}>
                {(option) => (
                  <Card>
                    <h3>{option.title}</h3>
                    <Show when={option.description}>
                      <p>{option.description}</p>
                    </Show>
                    <p class="wb-note">
                      {option.source.url} @{" "}
                      {option.source.ref ?? "latest stable SemVer"}
                    </p>
                    <p class="wb-note">module: {option.source.path}</p>
                    <Button
                      type="button"
                      variant="primary"
                      disabled={selectingId() !== undefined}
                      onClick={() => void choose(option)}
                    >
                      {selectingId() === option.id
                        ? "固定しています…"
                        : "この Capsule を確認"}
                    </Button>
                  </Card>
                )}
              </For>
            </section>
          )}
        </Show>
      </Show>
    </div>
  );
}
