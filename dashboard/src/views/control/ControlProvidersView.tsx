import { createResource, For, Match, Show, Switch } from "solid-js";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import StatusPill from "../account/components/StatusPill.tsx";
import SpaceSelector from "./SpaceSelector.tsx";
import { currentSpaceId } from "./space-state.ts";
import {
  type ControlApiError,
  listProviderTemplates,
  type ProviderCredentialSource,
  type ProviderTemplate,
} from "../../lib/control-api.ts";

interface ProviderSurface {
  readonly backendAvailable: boolean;
  readonly providers: readonly ProviderTemplate[];
}

export default function ControlProvidersView() {
  return <Page title="Providers">{() => <Inner />}</Page>;
}

function Inner() {
  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);
  const [surface] = createResource(spaceId, loadProviderSurface);

  return (
    <AppShell>
      <div class="page-header">
        <h1>Providers</h1>
        <p class="page-sub">
          Provider Template と Provider Env Set の導入面を確認します。
        </p>
      </div>

      <SpaceSelector />

      <Show
        when={spaceId()}
        fallback={
          <section class="empty-state">
            <p>Space を選択すると provider surface を表示します。</p>
          </section>
        }
      >
        <Switch>
          <Match when={surface.loading}>
            <div class="grid-skel">
              <div class="skel-card" />
              <div class="skel-card" />
            </div>
          </Match>
          <Match when={surface.error}>
            <section class="empty-state error-state">
              <p>
                取得に失敗しました —{" "}
                {(surface.error as ControlApiError).message}
              </p>
            </section>
          </Match>
          <Match when={surface()}>
            {(state) => (
              <>
                <Show when={!state().backendAvailable}>
                  <section class="empty-state provider-backend-note">
                    <p>
                      Provider Template API はまだ backend
                      に接続されていません。 UI surface
                      は先に有効化されています。
                    </p>
                  </section>
                </Show>

                <section class="detail-section">
                  <div class="section-heading-row">
                    <div>
                      <h2>Provider Templates</h2>
                      <p class="muted">
                        Takosumi 提供と user env set の credential source、 推奨
                        env 名、補助 flow を一覧します。
                      </p>
                    </div>
                  </div>

                  <Show
                    when={state().providers.length > 0}
                    fallback={
                      <section class="empty-state">
                        <p>
                          Provider Template の backend response はまだ空です。
                        </p>
                      </section>
                    }
                  >
                    <div class="provider-grid">
                      <For each={state().providers}>
                        {(provider) => <ProviderCard provider={provider} />}
                      </For>
                    </div>
                  </Show>
                </section>

                <section class="detail-section">
                  <div class="section-heading-row">
                    <div>
                      <h2>Provider Env Sets</h2>
                      <p class="muted">
                        Space-owned provider credentials は Connection
                        として管理します。 OAuth / AssumeRole / impersonation は
                        env set 作成・更新の補助 flow です。
                      </p>
                    </div>
                  </div>

                  <section class="empty-state">
                    <p>
                      Provider Env Set は Connections の「その他のプロバイダー
                      （Provider Env Set）」から作成します。任意 provider 名と
                      環境変数 (NAME=value) を登録すると、user_env_set
                      credential source と custom runner class で実行されます。
                    </p>
                  </section>
                </section>
              </>
            )}
          </Match>
        </Switch>
      </Show>
    </AppShell>
  );
}

async function loadProviderSurface(spaceId: string): Promise<ProviderSurface> {
  try {
    void spaceId;
    const providers = await listProviderTemplates();
    return {
      backendAvailable: true,
      providers,
    };
  } catch (err) {
    const apiErr = err as ControlApiError;
    if (apiErr.status === 404 || apiErr.status === 501) {
      return {
        backendAvailable: false,
        providers: [],
      };
    }
    throw err;
  }
}

function ProviderCard(props: { readonly provider: ProviderTemplate }) {
  const provider = () => props.provider;
  return (
    <article class="provider-card">
      <div class="provider-card-head">
        <div>
          <h3>{provider().displayName}</h3>
          <code>{provider().providerSource}</code>
        </div>
        <StatusPill class={providerSourceClass(provider().credentialSources)}>
          {providerSourceLabel(provider().credentialSources)}
        </StatusPill>
      </div>

      <dl class="provider-meta">
        <div>
          <dt>Helpers</dt>
          <dd>
            <InlineCodeList items={provider().helpers} />
          </dd>
        </div>
        <div>
          <dt>Env</dt>
          <dd>
            <InlineCodeList items={provider().recommendedEnvNames} />
          </dd>
        </div>
        <div>
          <dt>Credential</dt>
          <dd>
            <InlineCodeList items={provider().credentialSources} />
          </dd>
        </div>
      </dl>
    </article>
  );
}

function InlineCodeList(props: { readonly items: readonly string[] }) {
  return (
    <Show when={props.items.length > 0} fallback={<span class="muted">—</span>}>
      <span class="inline-code-list">
        <For each={props.items}>{(item) => <code>{item}</code>}</For>
      </span>
    </Show>
  );
}

function providerSourceLabel(
  sources: readonly ProviderCredentialSource[],
): string {
  return sources.includes("takosumi_managed")
    ? "takosumi managed"
    : "user env set";
}

function providerSourceClass(
  sources: readonly ProviderCredentialSource[],
): string {
  return sources.includes("takosumi_managed")
    ? "status-ready"
    : "status-installing";
}
