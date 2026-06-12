import "../../styles/wave-b.css";
import { createResource, For, Match, Show, Switch } from "solid-js";
import { KeyRound, Boxes } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import SpaceSelector from "./SpaceSelector.tsx";
import { currentSpaceId } from "./space-state.ts";
import {
  type ControlApiError,
  listProviderTemplates,
  type ProviderCredentialSource,
  type ProviderTemplate,
} from "../../lib/control-api.ts";
import {
  Badge,
  Card,
  CardHeader,
  CardSection,
  EmptyState,
  Eyebrow,
  PageHeader,
  Skeleton,
} from "../../components/ui/index.ts";

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
      <PageHeader
        eyebrow="CONTROL"
        title="Providers"
        subtitle="Provider Template と Provider Env Set の導入面を確認します。"
      />

      <SpaceSelector />

      <Show
        when={spaceId()}
        fallback={
          <EmptyState
            ink
            icon={<Boxes size={28} />}
            title="Space を選択"
            message="Space を選択すると provider surface を表示します。"
          />
        }
      >
        <Switch>
          <Match when={surface.loading}>
            <div class="wb-provider-grid">
              <Skeleton variant="card" count={3} />
            </div>
          </Match>
          <Match when={surface.error}>
            <EmptyState
              icon={<Boxes size={28} />}
              title="取得に失敗しました"
              message={(surface.error as ControlApiError).message}
            />
          </Match>
          <Match when={surface()}>
            {(state) => (
              <div class="wb-stack">
                <Show when={!state().backendAvailable}>
                  <Card>
                    <CardSection>
                      <p class="wb-note">
                        Provider Template API はまだ backend
                        に接続されていません。 UI surface は先に有効化されています。
                      </p>
                    </CardSection>
                  </Card>
                </Show>

                <section class="wb-stack-tight">
                  <div>
                    <Eyebrow>Provider Templates</Eyebrow>
                    <p class="wb-note">
                      Takosumi 提供と user env set の credential source、 推奨
                      env 名、補助 flow を一覧します。
                    </p>
                  </div>

                  <Show
                    when={state().providers.length > 0}
                    fallback={
                      <EmptyState
                        icon={<Boxes size={28} />}
                        title="Provider Template はまだ空です"
                        message="Provider Template の backend response はまだ空です。"
                      />
                    }
                  >
                    <div class="wb-provider-grid">
                      <For each={state().providers}>
                        {(provider) => <ProviderCard provider={provider} />}
                      </For>
                    </div>
                  </Show>
                </section>

                <section class="wb-stack-tight">
                  <div>
                    <Eyebrow>Provider Env Sets</Eyebrow>
                    <p class="wb-note">
                      Space-owned provider credentials は Connection
                      として管理します。 OAuth / AssumeRole / impersonation は
                      env set 作成・更新の補助 flow です。
                    </p>
                  </div>

                  <Card>
                    <CardSection>
                      <p class="wb-note">
                        Provider Env Set は Connections の「その他のプロバイダー
                        （Provider Env Set）」から作成します。任意 provider 名と
                        環境変数 (NAME=value) を登録すると、user_env_set
                        credential source と custom runner class で実行されます。
                      </p>
                    </CardSection>
                  </Card>
                </section>
              </div>
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
    <Card hover>
      <CardHeader
        title={provider().displayName}
        subtitle={<code class="wb-mono">{provider().providerSource}</code>}
        actions={
          <Badge tone={providerSourceTone(provider().credentialSources)}>
            {providerSourceLabel(provider().credentialSources)}
          </Badge>
        }
      />
      <CardSection>
        <dl class="wb-provider-meta">
          <div class="wb-provider-meta-row">
            <dt>Helpers</dt>
            <dd>
              <InlineCodeList items={provider().helpers} />
            </dd>
          </div>
          <div class="wb-provider-meta-row">
            <dt>Env</dt>
            <dd>
              <InlineCodeList items={provider().recommendedEnvNames} />
            </dd>
          </div>
          <div class="wb-provider-meta-row">
            <dt>Credential</dt>
            <dd>
              <InlineCodeList items={provider().credentialSources} />
            </dd>
          </div>
        </dl>
      </CardSection>
    </Card>
  );
}

function InlineCodeList(props: { readonly items: readonly string[] }) {
  return (
    <Show when={props.items.length > 0} fallback={<span class="muted">—</span>}>
      <ul class="wb-chips">
        <For each={props.items}>
          {(item) => (
            <li class="wb-chip">
              <KeyRound size={11} />
              {item}
            </li>
          )}
        </For>
      </ul>
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

function providerSourceTone(
  sources: readonly ProviderCredentialSource[],
): "ok" | "info" {
  return sources.includes("takosumi_managed") ? "ok" : "info";
}
