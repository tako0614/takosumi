import { createSignal, For, Show } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import Page from "../account/components/auth/Page.tsx";
import PageHeader from "../../components/ui/PageHeader.tsx";
import { Button, Card, Spinner } from "../../components/ui/index.ts";
import {
  parseCompositionInstallLink,
  parseCompositionManifestText,
  type CapsuleCompositionComponent,
  type CapsuleCompositionManifest,
} from "../../lib/composition-manifest.ts";
import {
  createSource,
  extractRunId,
  readSourceSnapshotFile,
  syncSource,
  waitForLatestSourceSnapshot,
} from "../../lib/control-api.ts";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";

export default function CompositionInstallView() {
  return <Page title="構成から追加">{() => <Inner />}</Page>;
}

function Inner() {
  const location = useLocation();
  const navigate = useNavigate();
  const link = () => parseCompositionInstallLink(location.search);
  const [composition, setComposition] = createSignal<{
    readonly manifest: CapsuleCompositionManifest;
    readonly digest: string;
  }>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();

  const loadComposition = async () => {
    const selector = link();
    const workspaceId = currentWorkspaceId();
    if (!selector) {
      setError("無効な構成 Source selector です");
      return;
    }
    if (!workspaceId) {
      setError("構成を確認する前に Workspace を選択してください");
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const source = await createSource({
        workspaceId,
        name: `composition-${selector.path
          .split("/")
          .at(-1)!
          .replace(/\.json$/u, "")}`,
        url: selector.git,
        defaultRef: selector.ref,
        defaultPath: ".",
        autoSync: false,
      });
      const sync = await syncSource(source.source.id);
      const snapshot = await waitForLatestSourceSnapshot(source.source.id, {
        runId: extractRunId(sync),
      });
      const file = await readSourceSnapshotFile(
        source.source.id,
        snapshot.id,
        selector.path,
      );
      setComposition(await parseCompositionManifestText(file.text));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "構成 manifest を読み込めませんでした",
      );
    } finally {
      setLoading(false);
    }
  };

  const addComponent = (component: CapsuleCompositionComponent) => {
    const query = new URLSearchParams({
      git: component.source.url,
      ref: component.source.ref,
      path: component.source.path,
      name: component.id,
    });
    navigate(`/new?${query.toString()}`);
  };

  return (
    <div class="new-app-view">
      <PageHeader
        title="構成から追加"
        subtitle="選択した Capsule は通常の確認・Plan フローで追加されます。"
      />
      <Show
        when={!loading()}
        fallback={
          <div class="wb-status-panel" role="status">
            <Spinner size={18} /> Git SourceSnapshot から構成を確認しています…
          </div>
        }
      >
        <Show when={error()}>
          <div class="wb-status-panel is-error" role="alert">
            {error()}
          </div>
        </Show>
        <Show
          when={composition()}
          fallback={
            <Card>
              <p>
                Git の ref を固定して SourceSnapshot を作成し、その中の manifest
                path を読みます。
              </p>
              <Button
                type="button"
                variant="primary"
                onClick={() => void loadComposition()}
              >
                構成を確認
              </Button>
            </Card>
          }
        >
          {(loaded) => (
            <section class="new-card-stack" aria-label="選択した構成">
              <Card>
                <h2>{loaded().manifest.metadata.title}</h2>
                <Show when={loaded().manifest.metadata.description}>
                  <p>{loaded().manifest.metadata.description}</p>
                </Show>
                <p class="wb-note">
                  manifest: {loaded().manifest.metadata.name}@
                  {loaded().manifest.metadata.version}
                </p>
                <p class="wb-note">digest: {loaded().digest}</p>
              </Card>
              <For each={loaded().manifest.components}>
                {(component) => (
                  <Card>
                    <h3>{component.title}</h3>
                    <Show when={component.description}>
                      <p>{component.description}</p>
                    </Show>
                    <p class="wb-note">
                      {component.source.url} @ {component.source.ref}
                    </p>
                    <Button
                      type="button"
                      variant="primary"
                      onClick={() => addComponent(component)}
                    >
                      この Capsule を追加
                    </Button>
                  </Card>
                )}
              </For>
              <Show when={(loaded().manifest.connections?.length ?? 0) > 0}>
                <Card>
                  <h3>接続の確認</h3>
                  <p>
                    接続は自動認可されません。各 Capsule の追加後に Takosumi が
                    Interface と InterfaceBinding を確認します。
                  </p>
                  <ul>
                    <For each={loaded().manifest.connections}>
                      {(connection) => (
                        <li>
                          {connection.from.component}.
                          {connection.from.interface} →{" "}
                          {connection.to.component}.{connection.to.interface}
                        </li>
                      )}
                    </For>
                  </ul>
                </Card>
              </Show>
            </section>
          )}
        </Show>
      </Show>
    </div>
  );
}
