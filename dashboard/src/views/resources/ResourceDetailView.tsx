import { useNavigate, useParams } from "@solidjs/router";
import {
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  type JSX,
} from "solid-js";
import {
  Activity,
  ArrowLeft,
  Eye,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-solid";
import Page from "../account/components/auth/Page.tsx";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";
import {
  deleteResourceShape,
  getResourceShape,
  listResourceShapeEvents,
  observeResourceShape,
  refreshResourceShape,
  type ResourceShapeResult,
} from "../../lib/control-api.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import {
  prettyJson,
  resourceOutputKeys,
  resourcePhaseTone,
} from "../../lib/resource-shapes.ts";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import { formatDateTime, t } from "../../i18n/index.ts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardSection,
  EmptyState,
  PageHeader,
  Skeleton,
  Toast,
} from "../../components/ui/index.ts";
import ResourceEditor from "./ResourceEditor.tsx";

type Identity = {
  readonly workspaceId: string;
  readonly space: string;
  readonly kind: string;
  readonly name: string;
};

function objectBucketStorageClass(
  resource: ResourceShapeResult,
): "standard" | "infrequent_access" | undefined {
  if (resource.kind !== "ObjectBucket") return undefined;
  const value = resource.spec.storageClass;
  if (value === undefined || value === "standard") return "standard";
  return value === "infrequent_access" ? value : undefined;
}

export default function ResourceDetailView(): JSX.Element {
  const params = useParams<{ kind: string; name: string }>();
  return (
    <Page title={`${params.kind ?? "Resource"}/${params.name ?? ""}`}>
      {() => <Inner />}
    </Page>
  );
}

function Inner(): JSX.Element {
  const params = useParams<{ kind: string; name: string }>();
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const [editing, setEditing] = createSignal(false);
  const [busy, setBusy] = createSignal<"observe" | "refresh" | "delete">();
  const [message, setMessage] = createSignal<{
    readonly tone: "success" | "error";
    readonly text: string;
  }>();

  const identity = createMemo<Identity | undefined>(() => {
    const workspaceId = currentWorkspaceId();
    const kind = params.kind?.trim();
    const name = params.name?.trim();
    return workspaceId && kind && name
      ? { workspaceId, space: workspaceId, kind, name }
      : undefined;
  });

  const [resource, { refetch: refetchResource }] = createResource(
    identity,
    (item) =>
      getResourceShape(item.workspaceId, item.space, item.kind, item.name),
  );
  const [events, { refetch: refetchEvents }] = createResource(
    identity,
    (item) =>
      listResourceShapeEvents(
        item.workspaceId,
        item.space,
        item.kind,
        item.name,
      ),
  );

  const backHref = () => "/resources";

  async function runAction(action: "observe" | "refresh"): Promise<void> {
    const item = identity();
    if (!item) return;
    setBusy(action);
    setMessage(undefined);
    try {
      const result =
        action === "observe"
          ? await observeResourceShape(
              item.workspaceId,
              item.space,
              item.kind,
              item.name,
            )
          : await refreshResourceShape(
              item.workspaceId,
              item.space,
              item.kind,
              item.name,
            );
      setMessage({
        tone: "success",
        text:
          result.observation?.summary ??
          result.refresh?.summary ??
          t("resources.detail.actionComplete"),
      });
      await Promise.all([refetchResource(), refetchEvents()]);
    } catch (cause) {
      setMessage({ tone: "error", text: friendlyError(cause, t).message });
    } finally {
      setBusy(undefined);
    }
  }

  async function removeResource(): Promise<void> {
    const item = identity();
    if (!item) return;
    const proceed = await confirm({
      title: t("resources.detail.deleteTitle"),
      message: t("resources.detail.deleteMessage", {
        kind: item.kind,
        name: item.name,
      }),
      confirmText: t("common.delete"),
      danger: true,
    });
    if (!proceed) return;
    setBusy("delete");
    setMessage(undefined);
    try {
      await deleteResourceShape(
        item.workspaceId,
        item.space,
        item.kind,
        item.name,
      );
      navigate(backHref(), { replace: true });
    } catch (cause) {
      setMessage({ tone: "error", text: friendlyError(cause, t).message });
      setBusy(undefined);
    }
  }

  async function afterApplied(_result: ResourceShapeResult): Promise<void> {
    setEditing(false);
    setMessage({
      tone: "success",
      text: t("resources.editor.applied"),
    });
    await Promise.all([refetchResource(), refetchEvents()]);
  }

  return (
    <>
      <PageHeader
        eyebrow={t("resources.title")}
        title={`${params.kind}/${params.name}`}
        subtitle={t("resources.detail.subtitle", {
          space: identity()?.space ?? "—",
        })}
        actions={
          <div class="rs-header-actions">
            <Button
              href={backHref()}
              variant="ghost"
              icon={<ArrowLeft size={16} />}
            >
              {t("resources.detail.back")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              icon={<Eye size={16} />}
              busy={busy() === "observe"}
              disabled={busy() !== undefined || !resource()}
              onClick={() => void runAction("observe")}
            >
              {t("resources.detail.observe")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              icon={<RefreshCw size={16} />}
              busy={busy() === "refresh"}
              disabled={busy() !== undefined || !resource()}
              onClick={() => void runAction("refresh")}
            >
              {t("resources.detail.refresh")}
            </Button>
            <Button
              type="button"
              variant="danger"
              icon={<Trash2 size={16} />}
              busy={busy() === "delete"}
              disabled={busy() !== undefined || !resource()}
              onClick={() => void removeResource()}
            >
              {t("common.delete")}
            </Button>
          </div>
        }
      />

      <Show when={message()}>
        {(item) => <Toast tone={item().tone}>{item().text}</Toast>}
      </Show>

      <Switch>
        <Match when={!identity()}>
          <EmptyState
            icon={<Settings2 size={28} />}
            title={t("workspace.select")}
            message={t("workspace.selectMessage")}
          />
        </Match>
        <Match when={resource.loading}>
          <Skeleton variant="card" count={3} />
        </Match>
        <Match when={resource.error}>
          <EmptyState
            icon={<Settings2 size={28} />}
            title={t("resources.detail.loadFailed")}
            message={friendlyError(resource.error, t).message}
            action={
              <Button
                type="button"
                variant="secondary"
                onClick={() => void refetchResource()}
              >
                {t("common.retry")}
              </Button>
            }
          />
        </Match>
        <Match when={resource()}>
          {(item) => (
            <div class="rs-view">
              <div class="rs-detail-grid">
                <Card>
                  <CardHeader
                    title={t("resources.detail.status")}
                    actions={
                      <Badge tone={resourcePhaseTone(item().status?.phase)}>
                        {item().status?.phase ?? t("common.unknown")}
                      </Badge>
                    }
                  />
                  <CardSection>
                    <dl class="tg-kv">
                      <dt>{t("resources.detail.kind")}</dt>
                      <dd>{item().kind}</dd>
                      <dt>{t("resources.detail.space")}</dt>
                      <dd>{item().metadata.space}</dd>
                      <dt>{t("resources.detail.managedBy")}</dt>
                      <dd>{item().metadata.managedBy}</dd>
                      <dt>{t("resources.detail.generation")}</dt>
                      <dd>{item().status?.observedGeneration ?? "—"}</dd>
                    </dl>
                  </CardSection>
                </Card>

                <Card>
                  <CardHeader title={t("resources.detail.resolution")} />
                  <CardSection>
                    <Show
                      when={item().status?.resolution}
                      fallback={<p class="rs-muted">{t("common.none")}</p>}
                    >
                      {(resolution) => (
                        <dl class="tg-kv">
                          <dt>{t("resources.preview.target")}</dt>
                          <dd>{resolution().target}</dd>
                          <dt>{t("resources.preview.implementation")}</dt>
                          <dd>{resolution().selectedImplementation}</dd>
                          <dt>{t("resources.preview.portability")}</dt>
                          <dd>{resolution().portability}</dd>
                          <dt>{t("resources.detail.locked")}</dt>
                          <dd>
                            {resolution().locked
                              ? t("resources.detail.yes")
                              : t("resources.detail.no")}
                          </dd>
                        </dl>
                      )}
                    </Show>
                  </CardSection>
                </Card>
              </div>

              <Card>
                <CardHeader
                  title={t("resources.detail.desired")}
                  subtitle={t("resources.detail.desiredHint")}
                  actions={
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setEditing((value) => !value)}
                    >
                      {editing()
                        ? t("common.cancel")
                        : t("resources.detail.change")}
                    </Button>
                  }
                />
                <CardSection>
                  <Show when={objectBucketStorageClass(item())}>
                    {(storageClass) => (
                      <dl class="tg-kv">
                        <dt>{t("resources.editor.bucketStorageClass")}</dt>
                        <dd>
                          {storageClass() === "infrequent_access"
                            ? t(
                                "resources.editor.bucketStorageClass.infrequentAccess",
                              )
                            : t("resources.editor.bucketStorageClass.standard")}
                        </dd>
                      </dl>
                    )}
                  </Show>
                  <details class="rs-json-disclosure">
                    <summary>{t("resources.detail.showSpec")}</summary>
                    <pre class="rs-code-block">{prettyJson(item().spec)}</pre>
                  </details>
                </CardSection>
              </Card>

              <Show when={editing() && identity()}>
                {(current) => (
                  <ResourceEditor
                    workspaceId={current().workspaceId}
                    space={current().space}
                    resource={item()}
                    onCancel={() => setEditing(false)}
                    onApplied={afterApplied}
                  />
                )}
              </Show>

              <div class="rs-detail-grid">
                <Card>
                  <CardHeader
                    title={t("resources.detail.conditions")}
                    subtitle={t("resources.detail.conditionsHint")}
                  />
                  <CardSection>
                    <Show
                      when={(item().status?.conditions?.length ?? 0) > 0}
                      fallback={<p class="rs-muted">{t("common.none")}</p>}
                    >
                      <ul class="rs-condition-list">
                        <For each={item().status?.conditions ?? []}>
                          {(condition) => (
                            <li>
                              <div>
                                <strong>{condition.type}</strong>
                                <Badge
                                  tone={
                                    condition.status === "true"
                                      ? "ok"
                                      : condition.status === "false"
                                        ? "danger"
                                        : "muted"
                                  }
                                >
                                  {condition.status}
                                </Badge>
                              </div>
                              <Show
                                when={condition.reason || condition.message}
                              >
                                <p>{condition.message ?? condition.reason}</p>
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </CardSection>
                </Card>

                <Card>
                  <CardHeader
                    title={t("resources.detail.outputs")}
                    subtitle={t("resources.detail.outputsHint")}
                  />
                  <CardSection>
                    <Show
                      when={resourceOutputKeys(item()).length > 0}
                      fallback={<p class="rs-muted">{t("common.none")}</p>}
                    >
                      <div class="rs-output-keys">
                        <For each={resourceOutputKeys(item())}>
                          {(key) => <code>{key}</code>}
                        </For>
                      </div>
                    </Show>
                  </CardSection>
                </Card>
              </div>

              <Card>
                <CardHeader
                  title={t("resources.detail.events")}
                  subtitle={t("resources.detail.eventsHint")}
                  actions={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      icon={<Activity size={16} />}
                      onClick={() => void refetchEvents()}
                    >
                      {t("common.refresh")}
                    </Button>
                  }
                />
                <CardSection>
                  <Show when={events.loading}>
                    <Skeleton variant="row" count={3} />
                  </Show>
                  <Show when={events.error}>
                    <Toast tone="error">
                      {friendlyError(events.error, t).message}
                    </Toast>
                  </Show>
                  <Show
                    when={
                      !events.loading &&
                      !events.error &&
                      (events()?.length ?? 0) > 0
                    }
                    fallback={
                      !events.loading && !events.error ? (
                        <p class="rs-muted">{t("resources.detail.noEvents")}</p>
                      ) : undefined
                    }
                  >
                    <ol class="rs-event-list">
                      <For each={events() ?? []}>
                        {(event) => (
                          <li>
                            <div>
                              <strong>{event.action}</strong>
                              <time datetime={event.createdAt}>
                                {formatDateTime(event.createdAt)}
                              </time>
                            </div>
                            <Show when={event.runId}>
                              {(runId) => <code>{runId()}</code>}
                            </Show>
                          </li>
                        )}
                      </For>
                    </ol>
                  </Show>
                </CardSection>
              </Card>
            </div>
          )}
        </Match>
      </Switch>
    </>
  );
}
