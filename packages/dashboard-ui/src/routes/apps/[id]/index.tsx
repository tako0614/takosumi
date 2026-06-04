import { Title } from "@solidjs/meta";
import { useParams } from "@solidjs/router";
import { createResource, For, Match, Show, Switch } from "solid-js";
import { Rocket } from "lucide-solid";
import AppShell from "~/components/shell/AppShell";
import Page from "~/components/auth/Page";
import AppStatusPill from "~/components/apps/AppStatusPill";
import AppDetailNav from "~/components/apps/AppDetailNav";
import OutputValue from "~/components/apps/installation-detail/OutputValue";
import WorkloadServicesSection from "~/components/apps/installation-detail/WorkloadServicesSection";
import OidcClientSection from "~/components/apps/installation-detail/OidcClientSection";
import MaterializeForm from "~/components/apps/installation-detail/MaterializeForm";
import ExportForm from "~/components/apps/installation-detail/ExportForm";
import EventsSection from "~/components/apps/installation-detail/EventsSection";
import { ApiError, rpc } from "~/lib/rpc";
import { appDetailLaunchState } from "~/lib/app-launch";

export default function AppDetail() {
  return <Page>{() => <Inner />}</Page>;
}

function Inner() {
  const params = useParams<{ id: string }>();
  const [app, { refetch }] = createResource(
    () => params.id,
    rpc.installations.get,
  );
  const [services, { refetch: refetchServices }] = createResource(
    () => params.id,
    rpc.installations.services,
  );
  return (
    <AppShell>
      <Switch>
        <Match when={app.loading}>
          <Title>Loading...</Title>
          <div class="skel-block tall" />
        </Match>
        <Match when={app.error}>
          <Title>取得失敗 — Takosumi</Title>
          <div class="page-header">
            <h1>取得に失敗しました</h1>
          </div>
          <p>{(app.error as ApiError).message}</p>
          <a href="/apps" class="btn btn-secondary" style="margin-top: 16px;">
            Apps 一覧へ戻る
          </a>
        </Match>
        <Match when={app()}>
          {(a) => (
            <>
              <Title>{a().appId} — Takosumi</Title>
              <div class="page-header">
                <h1>
                  {a().appId} <AppStatusPill status={a().status} />
                </h1>
                <p class="page-sub">
                  installation id: <code>{a().installationId}</code>
                </p>
              </div>
              <AppDetailNav installationId={a().installationId} />

              {(() => {
                const launch = appDetailLaunchState(a(), {
                  origin:
                    typeof location === "undefined"
                      ? "https://accounts.takosumi.com"
                      : location.origin,
                  hostname:
                    typeof location === "undefined"
                      ? "accounts.takosumi.com"
                      : location.hostname,
                });
                return (
                  <section class="detail-section">
                    <h2>Launch</h2>
                    <p class="muted">{launch.description}</p>
                    <Show when={launch.href}>
                      {(href) => (
                        <a href={href()} class="btn btn-primary">
                          <Rocket size={16} /> {launch.label}
                        </a>
                      )}
                    </Show>
                  </section>
                );
              })()}

              <section class="detail-section">
                <h2>Source</h2>
                <dl class="kv-list">
                  <dt>Git URL</dt>
                  <dd>
                    <code>{a().sourceGitUrl ?? "—"}</code>
                  </dd>
                  <dt>Ref</dt>
                  <dd>
                    <code>{a().sourceRef ?? "—"}</code>
                  </dd>
                  <dt>Commit</dt>
                  <dd>
                    <code>{a().sourceCommit ?? "—"}</code>
                  </dd>
                  <dt>Plan digest</dt>
                  <dd>
                    <code>{a().planDigest ?? "—"}</code>
                  </dd>
                  <dt>Artifact digest</dt>
                  <dd>
                    <code>{a().artifactDigest ?? "—"}</code>
                  </dd>
                  <dt>Mode</dt>
                  <dd>{a().mode ?? "—"}</dd>
                  <dt>Space</dt>
                  <dd>{a().spaceId ?? "—"}</dd>
                  <dt>Installed by</dt>
                  <dd>
                    <code>{a().createdBySubject ?? "—"}</code>
                  </dd>
                  <dt>Installed at</dt>
                  <dd>{a().createdAt ?? "—"}</dd>
                </dl>
              </section>

              <section class="detail-section">
                <h2>Deployment outputs</h2>
                <Show
                  when={(a().deploymentOutputs ?? []).length > 0}
                  fallback={<p class="muted">—</p>}
                >
                  <dl class="kv-list">
                    <For each={a().deploymentOutputs ?? []}>
                      {(output) => (
                        <>
                          <dt>{output.name}</dt>
                          <dd>
                            <code>{output.kind}</code>{" "}
                            <OutputValue value={output.value} />
                          </dd>
                        </>
                      )}
                    </For>
                  </dl>
                </Show>
              </section>

              <WorkloadServicesSection
                installationId={a().installationId}
                services={services()}
                loading={services.loading}
                error={services.error}
                onRotated={() => void refetchServices()}
              />

              <OidcClientSection client={a().oidcClient} />

              <section class="detail-section">
                <h2>Operations</h2>
                <MaterializeForm
                  installation={a()}
                  onDone={() => void refetch()}
                />
                <ExportForm installationId={a().installationId} />
              </section>

              <EventsSection installationId={a().installationId} />

              <section class="detail-section">
                <p class="muted">Uninstall は Danger zone から実行できます。</p>
                <a href="/apps" class="btn btn-secondary">
                  ← Apps 一覧へ戻る
                </a>
              </section>
            </>
          )}
        </Match>
      </Switch>
    </AppShell>
  );
}
