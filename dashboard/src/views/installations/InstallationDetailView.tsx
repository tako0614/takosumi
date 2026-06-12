/**
 * Installation detail (overview) screen.
 *
 * Ported from takosumi dashboard-ui `routes/apps/[id]/index.tsx` plus its
 * installation-detail sub-components (WorkloadServicesSection, MaterializeForm,
 * ExportForm, EventsSection, OidcClientSection, OutputValue), AppDetailNav, and
 * the app-launch helper. The conversion folds all of those into this single
 * self-contained module: SolidStart SSR loaders become client-side
 * createResource/fetch against the same-origin `/v1/*` account plane (mounted
 * in-process at the worker origin root), `lucide-solid` icons map onto the
 * takos `Icons` set, and the dashboard chrome comes from the shared
 * `views/account` shell.
 */
import "../../styles/wave-d.css";
import {
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  type JSX,
} from "solid-js";
import { useParams } from "@solidjs/router";
import { Icons } from "../../lib/Icons.tsx";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import AppStatusPill from "../account/components/AppStatusPill.tsx";
import AppDetailNav from "../account/components/AppDetailNav.tsx";
import {
  ApiError,
  type ExportOperation,
  type Installation,
  type InstallationEvent,
  type OidcClientConfig,
  rpc,
  type RotateWorkloadServiceTokenResult,
  type WorkloadService,
} from "../account/lib/api.ts";
import { ActionError, createAction } from "../account/lib/action.tsx";
import {
  exportStatusLabel,
  serviceStatusLabel,
} from "../../lib/status-labels.ts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardSection,
  Checkbox,
  type Column,
  DataTable,
  FormField,
  Input,
  KVList,
  type KVItem,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
} from "../../components/ui/index.ts";

export default function InstallationDetailView() {
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
          <Skeleton variant="block" style="height: 200px;" />
        </Match>
        <Match when={app.error}>
          <PageHeader title="取得に失敗しました" />
          <p>{(app.error as ApiError).message}</p>
          <div class="wave-d-actions" style="margin-top: 16px;">
            <Button href="/apps" variant="secondary">
              アプリ一覧へ戻る
            </Button>
          </div>
        </Match>
        <Match when={app()}>
          {(a) => (
            <>
              <PageHeader
                eyebrow="Installation"
                title={a().appId}
                subtitle={
                  <>
                    installation id:{" "}
                    <code class="wave-d-mono">{a().installationId}</code>
                  </>
                }
                actions={<AppStatusPill status={a().status} />}
              />
              <AppDetailNav installationId={a().installationId} />

              <div class="wave-d-stack">
                {(() => {
                  const launch = appDetailLaunchState(a(), {
                    origin:
                      typeof location === "undefined"
                        ? "https://app.takosumi.com"
                        : location.origin,
                    hostname:
                      typeof location === "undefined"
                        ? "app.takosumi.com"
                        : location.hostname,
                  });
                  return (
                    <Card>
                      <CardHeader
                        title="Launch"
                        subtitle={launch.description}
                      />
                      <Show when={launch.href}>
                        {(href) => (
                          <CardSection>
                            <Button
                              href={href()}
                              variant="primary"
                              icon={<Icons.Play class="w-4 h-4" />}
                            >
                              {launch.label}
                            </Button>
                          </CardSection>
                        )}
                      </Show>
                    </Card>
                  );
                })()}

                <Card>
                  <CardHeader title="Source" />
                  <CardSection>
                    <KVList
                      items={[
                        {
                          label: "Git URL",
                          value: (
                            <code class="wave-d-mono">
                              {a().sourceGitUrl ?? "—"}
                            </code>
                          ),
                        },
                        {
                          label: "Ref",
                          value: (
                            <code class="wave-d-mono">
                              {a().sourceRef ?? "—"}
                            </code>
                          ),
                        },
                        {
                          label: "Commit",
                          value: (
                            <code class="wave-d-mono">
                              {a().sourceCommit ?? "—"}
                            </code>
                          ),
                        },
                        {
                          label: "Plan digest",
                          value: (
                            <code class="wave-d-mono">
                              {a().planDigest ?? "—"}
                            </code>
                          ),
                        },
                        {
                          label: "Artifact digest",
                          value: (
                            <code class="wave-d-mono">
                              {a().artifactDigest ?? "—"}
                            </code>
                          ),
                        },
                        { label: "Mode", value: a().mode ?? "—" },
                        { label: "Space", value: a().spaceId ?? "—" },
                        {
                          label: "Installed by",
                          value: (
                            <code class="wave-d-mono">
                              {a().createdBySubject ?? "—"}
                            </code>
                          ),
                        },
                        { label: "Installed at", value: a().createdAt ?? "—" },
                      ]}
                    />
                  </CardSection>
                </Card>

                <Card>
                  <CardHeader title="Installation outputs" />
                  <CardSection>
                    <Show
                      when={(a().installationOutputs ?? []).length > 0}
                      fallback={<p class="tg-card-subtitle">—</p>}
                    >
                      <KVList
                        items={(a().installationOutputs ?? []).map(
                          (output): KVItem => ({
                            label: output.name,
                            value: (
                              <>
                                <code class="wave-d-mono">{output.kind}</code>
                                {" "}
                                <OutputValue value={output.value} />
                              </>
                            ),
                          }),
                        )}
                      />
                    </Show>
                  </CardSection>
                </Card>

                <WorkloadServicesSection
                  installationId={a().installationId}
                  services={services()}
                  loading={services.loading}
                  error={services.error}
                  onRotated={() => void refetchServices()}
                />

                <OidcClientSection client={a().oidcClient} />

                <Card>
                  <CardHeader title="Operations" />
                  <CardSection>
                    <MaterializeForm
                      installation={a()}
                      onDone={() => void refetch()}
                    />
                  </CardSection>
                  <CardSection>
                    <ExportForm installationId={a().installationId} />
                  </CardSection>
                </Card>

                <EventsSection installationId={a().installationId} />

                <Card>
                  <CardSection>
                    <p class="tg-card-subtitle">
                      アプリの削除は Danger zone から実行できます。
                    </p>
                    <div class="wave-d-actions">
                      <Button href="/apps" variant="secondary">
                        ← アプリ一覧へ戻る
                      </Button>
                    </div>
                  </CardSection>
                </Card>
              </div>
            </>
          )}
        </Match>
      </Switch>
    </AppShell>
  );
}

// ===========================================================================
// OutputValue
// ===========================================================================

function OutputValue(props: { readonly value: unknown }): JSX.Element {
  const value = () => props.value;
  return (
    <Show
      when={typeof value() === "string" ? (value() as string) : undefined}
      fallback={<code class="wave-d-mono">{JSON.stringify(value())}</code>}
    >
      {(text) => (
        <Show
          when={text().startsWith("https://") || text().startsWith("http://")}
          fallback={<code class="wave-d-mono">{text()}</code>}
        >
          <a href={text()}>{text()}</a>
        </Show>
      )}
    </Show>
  );
}

// ===========================================================================
// WorkloadServicesSection
// ===========================================================================

function WorkloadServicesSection(props: {
  installationId: string;
  services: readonly WorkloadService[] | undefined;
  loading: boolean;
  error: unknown;
  onRotated: () => void;
}) {
  const [busyService, setBusyService] = createSignal<string | null>(null);
  const [rotation, setRotation] =
    createSignal<RotateWorkloadServiceTokenResult | null>(null);
  const [err, setErr] = createSignal<string | null>(null);

  const rotate = async (service: WorkloadService) => {
    setBusyService(service.id);
    setErr(null);
    setRotation(null);
    try {
      const result = await rpc.installations.rotateServiceToken(
        props.installationId,
        service.id,
      );
      setRotation(result);
      props.onRotated();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusyService(null);
    }
  };

  const columns: readonly Column<WorkloadService>[] = [
    {
      header: "Service",
      cell: (service) => (
        <>
          <code class="wave-d-mono">{service.id}</code>
          <div class="tg-card-subtitle">{service.materialKind}</div>
        </>
      ),
    },
    {
      header: "Status",
      cell: (service) => (
        <Badge tone="neutral">{serviceStatusLabel(service.status)}</Badge>
      ),
    },
    {
      header: "Endpoint",
      cell: (service) => (
        <Show when={service.endpoint} fallback={<>—</>}>
          {(endpoint) => <OutputValue value={endpoint()} />}
        </Show>
      ),
    },
    {
      header: "Secret",
      cell: (service) => (
        <Show when={service.secretRef} fallback={<>—</>}>
          {(secretRef) => (
            <>
              <code class="wave-d-mono">{secretRef()}</code>
              <Show when={service.tokenExpiresAt}>
                {(expiresAt) => (
                  <div class="tg-card-subtitle">expires {expiresAt()}</div>
                )}
              </Show>
            </>
          )}
        </Show>
      ),
    },
    {
      header: "",
      align: "right",
      cell: (service) => (
        <Show when={service.rotateTokenUrl}>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={busyService() === service.id}
            busy={busyService() === service.id}
            icon={<Icons.RefreshCw class="w-4 h-4" />}
            onClick={() => void rotate(service)}
          >
            {busyService() === service.id ? "Rotating" : "Rotate"}
          </Button>
        </Show>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader title="Services" />
      <CardSection>
        <DataTable
          columns={columns}
          rows={props.services}
          rowKey={(service) => service.id}
          loading={props.loading}
          error={
            props.error ? "サービスを取得できませんでした。" : undefined
          }
          empty="—"
        />
        <Show when={rotation()}>
          {(result) => (
            <div class="wave-d-callout">
              <h3 class="wave-d-callout-title">
                <Icons.Key class="w-4 h-4" /> {result().service.id}
              </h3>
              <KVList
                items={[
                  {
                    label: "Token",
                    value: (
                      <Textarea
                        readOnly
                        rows={3}
                        value={result().token}
                        style="width: 100%;"
                      />
                    ),
                  },
                  {
                    label: "Secret ref",
                    value: (
                      <code class="wave-d-mono">
                        {result().service.secretRef ?? "—"}
                      </code>
                    ),
                  },
                  { label: "Expires", value: result().expiresAt },
                ]}
              />
            </div>
          )}
        </Show>
        <Show when={err()}>{(m) => <p class="wave-d-error">{m()}</p>}</Show>
      </CardSection>
    </Card>
  );
}

// ===========================================================================
// OidcClientSection
// ===========================================================================

function OidcClientSection(props: { client: OidcClientConfig | undefined }) {
  return (
    <Card>
      <CardHeader title="OIDC Client" />
      <CardSection>
        <Show
          when={props.client}
          fallback={
            <p class="tg-card-subtitle">
              この installation には OIDC client がありません。
            </p>
          }
        >
          {(client) => (
            <KVList
              items={[
                {
                  label: "Client ID",
                  value: <code class="wave-d-mono">{client().clientId}</code>,
                },
                {
                  label: "Issuer",
                  value: (
                    <code class="wave-d-mono">
                      {client().issuerUrl ?? "—"}
                    </code>
                  ),
                },
                {
                  label: "Service path",
                  value: (
                    <code class="wave-d-mono">
                      {client().servicePath ?? "—"}
                    </code>
                  ),
                },
                {
                  label: "Redirect URIs",
                  value: (
                    <Show
                      when={(client().redirectUris ?? []).length > 0}
                      fallback={<>—</>}
                    >
                      <For each={client().redirectUris ?? []}>
                        {(uri) => (
                          <div>
                            <code class="wave-d-mono">{uri}</code>
                          </div>
                        )}
                      </For>
                    </Show>
                  ),
                },
                {
                  label: "Allowed scopes",
                  value: (client().allowedScopes ?? []).join(", ") || "—",
                },
                { label: "Subject mode", value: client().subjectMode ?? "—" },
                {
                  label: "Token endpoint auth",
                  value: client().tokenEndpointAuthMethod ?? "—",
                },
              ]}
            />
          )}
        </Show>
      </CardSection>
    </Card>
  );
}

// ===========================================================================
// MaterializeForm
// ===========================================================================

function MaterializeForm(props: {
  installation: Installation;
  onDone: () => void;
}) {
  const [region, setRegion] = createSignal("default");
  const [costAck, setCostAck] = createSignal(false);

  const materialize = createAction(async () => {
    const updated = await rpc.installations.materialize(
      props.installation.installationId,
      { region: region(), costAck: costAck() },
    );
    props.onDone();
    return `materialize を受け付けました (status: ${updated.status ?? "?"})`;
  });
  const status = materialize.result;

  const run = (e: Event) => {
    e.preventDefault();
    materialize.clearResult();
    void materialize.run();
  };

  return (
    <div>
      <h3 class="wave-d-callout-title">
        <Icons.Server class="w-4 h-4" /> Materialize (dedicated)
      </h3>
      <p class="tg-card-subtitle">
        shared-cell の installation を専用セルへ昇格します。コストが発生するため
        確認が必要です。
      </p>
      <form class="wave-d-field-stack" onSubmit={run}>
        <FormField label="Region">
          <Input
            type="text"
            value={region()}
            onInput={(e) => setRegion(e.currentTarget.value)}
            placeholder="default"
          />
        </FormField>
        <Checkbox
          checked={costAck()}
          onChange={(e) => setCostAck(e.currentTarget.checked)}
          label="コスト発生を承認する (cost acknowledgement)"
        />
        <div class="wave-d-actions">
          <Button
            variant="primary"
            type="submit"
            disabled={materialize.busy() || !costAck()}
            busy={materialize.busy()}
            icon={<Icons.Server class="w-4 h-4" />}
          >
            {materialize.busy() ? "Materialize 中..." : "Materialize"}
          </Button>
        </div>
      </form>
      <Show when={status()}>
        {(m) => (
          <p class="tg-card-subtitle" style="margin-top: 8px;">
            {m()}
          </p>
        )}
      </Show>
      <ActionError error={materialize.error} />
    </div>
  );
}

// ===========================================================================
// ExportForm
// ===========================================================================

const EXPORT_POLL_ATTEMPTS = 12;
const EXPORT_POLL_INTERVAL_MS = 1500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    return (
      op.downloadUrl ??
      rpc.installations.exportDownloadUrl(props.installationId, op.operationId)
    );
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
    <div>
      <h3 class="wave-d-callout-title">
        <Icons.Download class="w-4 h-4" /> Export
      </h3>
      <p class="tg-card-subtitle">
        installation のエクスポートバンドルを作成します。完了するとダウンロード
        リンクが表示されます。
      </p>
      <form class="wave-d-field-stack" onSubmit={run}>
        <Checkbox
          checked={includeData()}
          onChange={(e) => setIncludeData(e.currentTarget.checked)}
          label="データを含める (include data)"
        />
        <FormField label="Encryption">
          <Select
            value={encryptionMethod()}
            onChange={(e) => setEncryptionMethod(e.currentTarget.value)}
          >
            <option value="none">none</option>
            <option value="age">age</option>
          </Select>
        </FormField>
        <Show when={encryptionMethod() !== "none"}>
          <FormField label="Recipients (1 行に 1 つ / カンマ区切り)">
            <Textarea
              value={recipients()}
              onInput={(e) => setRecipients(e.currentTarget.value)}
              placeholder="age1..."
              rows={3}
            />
          </FormField>
        </Show>
        <div class="wave-d-actions">
          <Button
            variant="secondary"
            type="submit"
            disabled={busy()}
            busy={busy()}
            icon={<Icons.Download class="w-4 h-4" />}
          >
            {busy() ? "Export 中..." : "Export"}
          </Button>
        </div>
      </form>
      <Show when={operation()}>
        {(op) => (
          <p class="tg-card-subtitle" style="margin-top: 8px;">
            操作 <code class="wave-d-mono">{op().operationId}</code> — 状態:{" "}
            <strong>{exportStatusLabel(op().status)}</strong>
          </p>
        )}
      </Show>
      <Show when={downloadHref()}>
        {(href) => (
          <div class="wave-d-actions" style="margin-top: 8px;">
            <Button
              href={href()}
              variant="primary"
              icon={<Icons.Download class="w-4 h-4" />}
            >
              ダウンロード
            </Button>
          </div>
        )}
      </Show>
      <Show when={err()}>{(m) => <p class="wave-d-error">{m()}</p>}</Show>
    </div>
  );
}

// ===========================================================================
// EventsSection
// ===========================================================================

function shortHash(hash: string | undefined): string {
  if (!hash) return "—";
  const body = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
  return body.length > 16 ? `${body.slice(0, 16)}…` : body;
}

function EventsSection(props: { installationId: string }) {
  const [events] = createResource(
    () => props.installationId,
    (id) => rpc.installations.events(id, { limit: 50 }),
  );

  const columns: readonly Column<InstallationEvent>[] = [
    { header: "Type", cell: (event) => event.type },
    { header: "Created", cell: (event) => event.createdAt ?? "—" },
    {
      header: "Event hash",
      cell: (event) => (
        <code class="wave-d-mono">{shortHash(event.eventHash)}</code>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader title="Events" />
      <CardSection>
        <Switch>
          <Match when={events.loading}>
            <Skeleton variant="block" />
          </Match>
          <Match when={events.error}>
            <p class="tg-card-subtitle">イベントを取得できませんでした。</p>
          </Match>
          <Match when={events()}>
            {(result) => (
              <Show
                when={result().events.length > 0}
                fallback={
                  <p class="tg-card-subtitle">まだイベントはありません。</p>
                }
              >
                <p class="tg-card-subtitle">
                  hash chain:{" "}
                  <Badge tone={result().hashChainValid ? "ok" : "danger"}>
                    {result().hashChainValid ? "valid" : "invalid"}
                  </Badge>
                </p>
                <DataTable
                  columns={columns}
                  rows={result().events}
                  rowKey={(event, index) => event.eventHash ?? index}
                />
              </Show>
            )}
          </Match>
        </Switch>
      </CardSection>
    </Card>
  );
}

// ===========================================================================
// Launch state helper (ported from lib/app-launch.ts + use-takos-start.ts)
// ===========================================================================

interface AppDetailLaunchState {
  readonly label: string;
  readonly description: string;
  readonly href?: string;
}

interface AppDetailLaunchEnvironment {
  readonly origin: string;
  readonly hostname: string;
}

function appDetailLaunchState(
  app: Installation,
  env: AppDetailLaunchEnvironment,
): AppDetailLaunchState {
  if (app.status !== "ready") return unavailableLaunchState(app.status);

  if (app.launchUrl) {
    return {
      label: "Launch app",
      href: app.launchUrl,
      description: "This Installation exposes a Cloud launch URL.",
    };
  }

  if (isManagedTakosInstallation(app)) {
    if (!app.accountId || !app.spaceId || !app.installationId) {
      return {
        label: "Launch unavailable",
        description:
          "Takos launch requires account, space, and installation identifiers.",
      };
    }
    const href = managedTakosLaunchUrl(app, env);
    if (!href) {
      return {
        label: "Launch unavailable",
        description:
          "This Installation is ready, but no Takos host is configured for this distribution.",
      };
    }
    return {
      label: "Launch Takos",
      href,
      description:
        "Takos launch issues a short-lived launch token from this account-plane Installation.",
    };
  }

  return {
    label: "Launch unavailable",
    description:
      "This Installation is ready, but no Cloud launch entry is configured.",
  };
}

function isManagedTakosInstallation(app: Installation): boolean {
  return (
    app.appId === "takos.chat" ||
    app.sourceGitUrl === "takos-product://managed/takos"
  );
}

function managedTakosLaunchUrl(
  app: Installation,
  env: AppDetailLaunchEnvironment,
): string | undefined {
  const takosUrl = tryDefaultTakosUrlForHost(env.hostname);
  if (!takosUrl) return undefined;
  if (!app.spaceId) return undefined;
  const url = new URL("/takos/start", env.origin);
  url.searchParams.set("takos_url", takosUrl);
  url.searchParams.set("account_id", app.accountId ?? "");
  url.searchParams.set("space_id", app.spaceId ?? "");
  url.searchParams.set("installation_id", app.installationId);
  url.searchParams.set("app_id", app.appId || "takos.chat");
  url.searchParams.set("return_to", `/spaces/${app.spaceId}/threads`);
  return url.toString();
}

function tryDefaultTakosUrlForHost(hostname: string): string | undefined {
  if (isLocalHost(hostname)) return "https://takos.test";
  const configured = readTakosUrlEnv();
  if (configured) return configured;
  return undefined;
}

function readTakosUrlEnv(): string | undefined {
  try {
    const meta = import.meta as unknown as {
      env?: { readonly VITE_TAKOSUMI_DASHBOARD_TAKOS_URL?: string };
    };
    return meta.env?.VITE_TAKOSUMI_DASHBOARD_TAKOS_URL?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname.endsWith(".test") ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

function unavailableLaunchState(
  status: Installation["status"],
): AppDetailLaunchState {
  switch (status) {
    case "installing":
      return {
        label: "Launch unavailable",
        description:
          "Installation is still preparing. Launch becomes available after it is ready.",
      };
    case "failed":
      return {
        label: "Launch unavailable",
        description: "Installation failed. Resolve the failure before launch.",
      };
    case "suspended":
      return {
        label: "Launch unavailable",
        description:
          "Installation is suspended. Resolve the account or billing action before launch.",
      };
    case "exported":
      return {
        label: "Launch unavailable",
        description: "Installation was exported and cannot be launched here.",
      };
    default:
      return {
        label: "Launch unavailable",
        description:
          "Installation status is unknown. Launch is disabled until status is ready.",
      };
  }
}
