import { Title } from "@solidjs/meta";
import { useParams } from "@solidjs/router";
import {
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { Download, HardDriveDownload, Rocket, Server } from "lucide-solid";
import AppShell from "~/components/shell/AppShell";
import AuthGuard from "~/components/auth/AuthGuard";
import AppStatusPill from "~/components/apps/AppStatusPill";
import AppDetailNav from "~/components/apps/AppDetailNav";
import {
  ApiError,
  type ExportOperation,
  type Installation,
  type OidcClientConfig,
  rpc,
} from "~/lib/rpc";
import { appDetailLaunchState } from "~/lib/app-launch";

export default function AppDetail() {
  return (
    <>
      <AuthGuard>{() => <Inner />}</AuthGuard>
    </>
  );
}

function Inner() {
  const params = useParams<{ id: string }>();
  const [app, { refetch }] = createResource(
    () => params.id,
    rpc.installations.get,
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
                  origin: typeof location === "undefined"
                    ? "https://accounts.takosumi.com"
                    : location.origin,
                  hostname: typeof location === "undefined"
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
                <p class="muted">
                  Uninstall は Danger zone から実行できます。
                </p>
                <a href="/apps" class="btn btn-secondary">← Apps 一覧へ戻る</a>
              </section>
            </>
          )}
        </Match>
      </Switch>
    </AppShell>
  );
}

function OidcClientSection(props: { client: OidcClientConfig | undefined }) {
  return (
    <section class="detail-section">
      <h2>OIDC Client</h2>
      <Show
        when={props.client}
        fallback={
          <p class="muted">
            この installation には OIDC client がありません。
          </p>
        }
      >
        {(client) => (
          <dl class="kv-list">
            <dt>Client ID</dt>
            <dd>
              <code>{client().clientId}</code>
            </dd>
            <dt>Issuer</dt>
            <dd>
              <code>{client().issuerUrl ?? "—"}</code>
            </dd>
            <dt>Service path</dt>
            <dd>
              <code>{client().servicePath ?? "—"}</code>
            </dd>
            <dt>Redirect URIs</dt>
            <dd>
              <Show
                when={(client().redirectUris ?? []).length > 0}
                fallback={<>—</>}
              >
                <For each={client().redirectUris ?? []}>
                  {(uri) => (
                    <div>
                      <code>{uri}</code>
                    </div>
                  )}
                </For>
              </Show>
            </dd>
            <dt>Allowed scopes</dt>
            <dd>{(client().allowedScopes ?? []).join(", ") || "—"}</dd>
            <dt>Subject mode</dt>
            <dd>{client().subjectMode ?? "—"}</dd>
            <dt>Token endpoint auth</dt>
            <dd>{client().tokenEndpointAuthMethod ?? "—"}</dd>
          </dl>
        )}
      </Show>
    </section>
  );
}

function MaterializeForm(props: {
  installation: Installation;
  onDone: () => void;
}) {
  const [region, setRegion] = createSignal("default");
  const [costAck, setCostAck] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal<string | null>(null);
  const [err, setErr] = createSignal<string | null>(null);

  const run = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setStatus(null);
    try {
      const updated = await rpc.installations.materialize(
        props.installation.installationId,
        { region: region(), costAck: costAck() },
      );
      setStatus(`materialize を受け付けました (status: ${updated.status ?? "?"})`);
      props.onDone();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="op-card">
      <h3>
        <Server size={16} /> Materialize (dedicated)
      </h3>
      <p class="muted">
        shared-cell の installation を専用セルへ昇格します。コストが発生するため
        確認が必要です。
      </p>
      <form class="install-form" onSubmit={run}>
        <label>
          Region
          <input
            type="text"
            value={region()}
            onInput={(e) => setRegion(e.currentTarget.value)}
            placeholder="default"
          />
        </label>
        <label class="op-checkbox">
          <input
            type="checkbox"
            checked={costAck()}
            onChange={(e) => setCostAck(e.currentTarget.checked)}
          />
          コスト発生を承認する (cost acknowledgement)
        </label>
        <button
          class="btn btn-primary"
          type="submit"
          disabled={busy() || !costAck()}
        >
          <Server size={16} /> {busy() ? "Materialize 中..." : "Materialize"}
        </button>
      </form>
      <Show when={status()}>
        {(m) => (
          <p class="muted" style="margin-top: 8px;">
            {m()}
          </p>
        )}
      </Show>
      <Show when={err()}>{(m) => <p class="sign-in-error">{m()}</p>}</Show>
    </div>
  );
}

const EXPORT_POLL_ATTEMPTS = 12;
const EXPORT_POLL_INTERVAL_MS = 1500;

function ExportForm(props: { installationId: string }) {
  const [includeData, setIncludeData] = createSignal(false);
  const [encryptionMethod, setEncryptionMethod] = createSignal("none");
  const [recipients, setRecipients] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [operation, setOperation] = createSignal<ExportOperation | null>(null);
  const [err, setErr] = createSignal<string | null>(null);

  const downloadHref = () => {
    const op = operation();
    if (!op || op.status !== "exported") return null;
    return op.downloadUrl ??
      rpc.installations.exportDownloadUrl(props.installationId, op.operationId);
  };

  const run = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setOperation(null);
    try {
      const recipientList = recipients()
        .split(/\r?\n|,/)
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
      let op = await rpc.installations.requestExport(props.installationId, {
        includeData: includeData(),
        encryptionMethod: encryptionMethod(),
        recipients: recipientList,
      });
      setOperation(op);
      // Poll the operation until it leaves the "preparing" state (or we give up).
      for (
        let attempt = 0;
        attempt < EXPORT_POLL_ATTEMPTS && op.status === "preparing";
        attempt++
      ) {
        await delay(EXPORT_POLL_INTERVAL_MS);
        op = await rpc.installations.getExportOperation(
          props.installationId,
          op.operationId,
        );
        setOperation(op);
      }
      if (op.status === "failed") {
        setErr(op.error ?? "export に失敗しました。");
      }
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="op-card">
      <h3>
        <HardDriveDownload size={16} /> Export
      </h3>
      <p class="muted">
        installation のエクスポートバンドルを作成します。完了するとダウンロード
        リンクが表示されます。
      </p>
      <form class="install-form" onSubmit={run}>
        <label class="op-checkbox">
          <input
            type="checkbox"
            checked={includeData()}
            onChange={(e) => setIncludeData(e.currentTarget.checked)}
          />
          データを含める (include data)
        </label>
        <label>
          Encryption
          <select
            value={encryptionMethod()}
            onChange={(e) => setEncryptionMethod(e.currentTarget.value)}
          >
            <option value="none">none</option>
            <option value="age">age</option>
          </select>
        </label>
        <Show when={encryptionMethod() !== "none"}>
          <label>
            Recipients (1 行に 1 つ / カンマ区切り)
            <textarea
              value={recipients()}
              onInput={(e) => setRecipients(e.currentTarget.value)}
              placeholder="age1..."
              rows={3}
            />
          </label>
        </Show>
        <button class="btn btn-secondary" type="submit" disabled={busy()}>
          <HardDriveDownload size={16} />{" "}
          {busy() ? "Export 中..." : "Export"}
        </button>
      </form>
      <Show when={operation()}>
        {(op) => (
          <p class="muted" style="margin-top: 8px;">
            operation <code>{op().operationId}</code> — status:{" "}
            <strong>{op().status}</strong>
          </p>
        )}
      </Show>
      <Show when={downloadHref()}>
        {(href) => (
          <a class="btn btn-primary" href={href()} style="margin-top: 8px;">
            <Download size={16} /> ダウンロード
          </a>
        )}
      </Show>
      <Show when={err()}>{(m) => <p class="sign-in-error">{m()}</p>}</Show>
    </div>
  );
}

function EventsSection(props: { installationId: string }) {
  const [events] = createResource(
    () => props.installationId,
    (id) => rpc.installations.events(id, { limit: 50 }),
  );
  return (
    <section class="detail-section">
      <h2>Events</h2>
      <Switch>
        <Match when={events.loading}>
          <div class="skel-block" />
        </Match>
        <Match when={events.error}>
          <p class="muted">イベントを取得できませんでした。</p>
        </Match>
        <Match when={events()}>
          {(result) => (
            <Show
              when={result().events.length > 0}
              fallback={<p class="muted">まだイベントはありません。</p>}
            >
              <p class="muted">
                hash chain:{" "}
                <strong>{result().hashChainValid ? "valid" : "invalid"}</strong>
              </p>
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Created</th>
                    <th>Event hash</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={result().events}>
                    {(event) => (
                      <tr>
                        <td>{event.type}</td>
                        <td>{event.createdAt ?? "—"}</td>
                        <td>
                          <code>{shortHash(event.eventHash)}</code>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          )}
        </Match>
      </Switch>
    </section>
  );
}

function OutputValue(props: { readonly value: unknown }) {
  const value = () => props.value;
  return (
    <Show
      when={typeof value() === "string" ? value() as string : undefined}
      fallback={<code>{JSON.stringify(value())}</code>}
    >
      {(text) => (
        <Show
          when={text().startsWith("https://") || text().startsWith("http://")}
          fallback={<code>{text()}</code>}
        >
          <a href={text()}>{text()}</a>
        </Show>
      )}
    </Show>
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortHash(hash: string | undefined): string {
  if (!hash) return "—";
  const body = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
  return body.length > 16 ? `${body.slice(0, 16)}…` : body;
}
