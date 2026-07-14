import {
  createMemo,
  createResource,
  createSignal,
  Show,
  type JSX,
} from "solid-js";
import { Boxes, Plus, RefreshCw, Settings2, Trash2 } from "lucide-solid";
import Page from "../account/components/auth/Page.tsx";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";
import {
  ControlApiError,
  deleteResourceSpacePolicy,
  deleteResourceTargetPool,
  listResourceShapes,
  listResourceSpacePolicies,
  listResourceTargetPools,
  putResourceSpacePolicy,
  putResourceTargetPool,
  type ResourceShape,
  type ResourceSpacePolicy,
  type ResourceSpacePolicySpec,
  type ResourceTargetPool,
  type ResourceTargetPoolSpec,
} from "../../lib/control-api.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import {
  parseJsonObjectText,
  prettyJson,
  resourcePhaseTone,
  resourceShapeHref,
} from "../../lib/resource-shapes.ts";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import { formatDateTime, t } from "../../i18n/index.ts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardSection,
  DataTable,
  EmptyState,
  PageHeader,
  Toast,
  type Column,
} from "../../components/ui/index.ts";
import ResourceEditor from "./ResourceEditor.tsx";

type Scope = { readonly workspaceId: string; readonly space: string };

export default function ResourcesView(): JSX.Element {
  return <Page title={t("resources.title")}>{() => <Inner />}</Page>;
}

function Inner(): JSX.Element {
  const { confirm } = useConfirmDialog();
  const workspaceId = () => currentWorkspaceId() || undefined;
  const [showEditor, setShowEditor] = createSignal(false);
  const [poolEditorOpen, setPoolEditorOpen] = createSignal(false);
  const [poolName, setPoolName] = createSignal("default");
  const [poolSpecText, setPoolSpecText] = createSignal(
    prettyJson({ targets: [] }),
  );
  const [poolBusy, setPoolBusy] = createSignal(false);
  const [poolMessage, setPoolMessage] = createSignal<{
    readonly tone: "success" | "error";
    readonly text: string;
  }>();
  const [policyName, setPolicyName] = createSignal("default");
  const [policyEditorOpen, setPolicyEditorOpen] = createSignal(false);
  const [policySpecText, setPolicySpecText] = createSignal(
    prettyJson({
      preferences: {
        cost: "balanced",
        operations: "managed",
        portability: "balanced",
      },
      approvals: { requireForApply: true, requireForDestroy: true },
    }),
  );
  const [policyBusy, setPolicyBusy] = createSignal(false);
  const [policyMessage, setPolicyMessage] = createSignal<{
    readonly tone: "success" | "error";
    readonly text: string;
  }>();

  const scope = createMemo<Scope | undefined>(() => {
    const workspace = workspaceId();
    return workspace ? { workspaceId: workspace, space: workspace } : undefined;
  });

  const [resources, { refetch: refetchResources }] = createResource(
    scope,
    ({ workspaceId: workspace, space: selectedSpace }) =>
      listResourceShapes(workspace, selectedSpace),
  );
  const [targetPools, { refetch: refetchTargetPools }] = createResource(
    scope,
    ({ workspaceId: workspace, space: selectedSpace }) =>
      listResourceTargetPools(workspace, selectedSpace),
  );
  const [spacePolicies, { refetch: refetchSpacePolicies }] = createResource(
    scope,
    ({ workspaceId: workspace, space: selectedSpace }) =>
      listResourceSpacePolicies(workspace, selectedSpace),
  );

  const resourceColumns: readonly Column<ResourceShape>[] = [
    {
      header: t("resources.column.resource"),
      cell: (resource) => (
        <div class="rs-resource-name">
          <strong>{resource.metadata.name}</strong>
          <code>{resource.kind}</code>
        </div>
      ),
    },
    {
      header: t("resources.column.phase"),
      cell: (resource) => (
        <Badge tone={resourcePhaseTone(resource.status?.phase)}>
          {resource.status?.phase ?? t("common.unknown")}
        </Badge>
      ),
    },
    {
      header: t("resources.column.target"),
      cell: (resource) => resource.status?.resolution?.target ?? "—",
    },
    {
      header: t("resources.column.managedBy"),
      cell: (resource) => resource.metadata.managedBy,
    },
    {
      header: "",
      align: "right",
      cell: (resource) => (
        <Button href={resourceShapeHref(resource)} variant="ghost" size="sm">
          {t("common.details")}
        </Button>
      ),
    },
  ];

  const poolColumns: readonly Column<ResourceTargetPool>[] = [
    {
      header: t("resources.targetPools.column.name"),
      cell: (pool) => <strong>{pool.name}</strong>,
    },
    {
      header: t("resources.targetPools.column.targets"),
      cell: (pool) => String(pool.spec.targets.length),
    },
    {
      header: t("resources.targetPools.column.updated"),
      cell: (pool) => formatDateTime(pool.updatedAt),
    },
    {
      header: "",
      align: "right",
      cell: (pool) => (
        <div class="rs-row-actions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => editTargetPool(pool)}
          >
            {t("resources.targetPools.edit")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t("resources.targetPools.deleteAria", {
              name: pool.name,
            })}
            onClick={() => void removeTargetPool(pool)}
          >
            <Trash2 size={16} aria-hidden="true" />
          </Button>
        </div>
      ),
    },
  ];

  const policyColumns: readonly Column<ResourceSpacePolicy>[] = [
    {
      header: t("resources.policy.column.name"),
      cell: (policy) => <strong>{policy.name}</strong>,
    },
    {
      header: t("resources.policy.column.updated"),
      cell: (policy) => formatDateTime(policy.updatedAt),
    },
    {
      header: "",
      align: "right",
      cell: (policy) => (
        <div class="rs-row-actions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => editSpacePolicy(policy)}
          >
            {t("resources.policy.edit")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t("resources.policy.deleteAria", {
              name: policy.name,
            })}
            onClick={() => void removeSpacePolicy(policy)}
          >
            <Trash2 size={16} aria-hidden="true" />
          </Button>
        </div>
      ),
    },
  ];

  const featureUnavailable = () =>
    resources.error instanceof ControlApiError &&
    resources.error.status === 404;

  function startTargetPool(): void {
    setPoolName("default");
    setPoolSpecText(prettyJson({ targets: [] }));
    setPoolMessage(undefined);
    setPoolEditorOpen(true);
  }

  function editTargetPool(pool: ResourceTargetPool): void {
    setPoolName(pool.name);
    setPoolSpecText(prettyJson(pool.spec));
    setPoolMessage(undefined);
    setPoolEditorOpen(true);
  }

  async function saveTargetPool(): Promise<void> {
    const active = scope();
    if (!active) return;
    const name = poolName().trim();
    if (!name) {
      setPoolMessage({
        tone: "error",
        text: t("resources.targetPools.nameRequired"),
      });
      return;
    }
    const parsed = parseJsonObjectText(poolSpecText());
    if (!parsed.ok || !Array.isArray(parsed.value.targets)) {
      setPoolMessage({
        tone: "error",
        text: t("resources.targetPools.specInvalid"),
      });
      return;
    }
    setPoolBusy(true);
    setPoolMessage(undefined);
    try {
      await putResourceTargetPool({
        ...active,
        name,
        spec: parsed.value as unknown as ResourceTargetPoolSpec,
      });
      setPoolMessage({
        tone: "success",
        text: t("resources.targetPools.saved"),
      });
      await refetchTargetPools();
    } catch (cause) {
      setPoolMessage({ tone: "error", text: friendlyError(cause, t).message });
    } finally {
      setPoolBusy(false);
    }
  }

  async function removeTargetPool(pool: ResourceTargetPool): Promise<void> {
    const active = scope();
    if (!active) return;
    const proceed = await confirm({
      title: t("resources.targetPools.deleteTitle"),
      message: t("resources.targetPools.deleteMessage", { name: pool.name }),
      confirmText: t("common.delete"),
      danger: true,
    });
    if (!proceed) return;
    try {
      await deleteResourceTargetPool(
        active.workspaceId,
        active.space,
        pool.name,
      );
      await refetchTargetPools();
    } catch (cause) {
      setPoolMessage({ tone: "error", text: friendlyError(cause, t).message });
    }
  }

  async function saveSpacePolicy(): Promise<void> {
    const active = scope();
    if (!active) return;
    const name = policyName().trim();
    if (!name) {
      setPolicyMessage({
        tone: "error",
        text: t("resources.policy.nameRequired"),
      });
      return;
    }
    const parsed = parseJsonObjectText(policySpecText());
    if (!parsed.ok) {
      setPolicyMessage({
        tone: "error",
        text: t("resources.policy.specInvalid"),
      });
      return;
    }
    setPolicyBusy(true);
    setPolicyMessage(undefined);
    try {
      await putResourceSpacePolicy({
        ...active,
        name,
        spec: parsed.value as ResourceSpacePolicySpec,
      });
      setPolicyMessage({
        tone: "success",
        text: t("resources.policy.saved"),
      });
      await refetchSpacePolicies();
    } catch (cause) {
      setPolicyMessage({
        tone: "error",
        text: friendlyError(cause, t).message,
      });
    } finally {
      setPolicyBusy(false);
    }
  }

  function startSpacePolicy(): void {
    setPolicyName("default");
    setPolicySpecText(
      prettyJson({
        preferences: {
          cost: "balanced",
          operations: "managed",
          portability: "balanced",
        },
        approvals: { requireForApply: true, requireForDestroy: true },
      }),
    );
    setPolicyMessage(undefined);
    setPolicyEditorOpen(true);
  }

  function editSpacePolicy(policy: ResourceSpacePolicy): void {
    setPolicyName(policy.name);
    setPolicySpecText(prettyJson(policy.spec));
    setPolicyMessage(undefined);
    setPolicyEditorOpen(true);
  }

  async function removeSpacePolicy(policy: ResourceSpacePolicy): Promise<void> {
    const active = scope();
    if (!active) return;
    const proceed = await confirm({
      title: t("resources.policy.deleteTitle"),
      message: t("resources.policy.deleteMessage", { name: policy.name }),
      confirmText: t("common.delete"),
      danger: true,
    });
    if (!proceed) return;
    try {
      await deleteResourceSpacePolicy(
        active.workspaceId,
        active.space,
        policy.name,
      );
      await refetchSpacePolicies();
    } catch (cause) {
      setPolicyMessage({
        tone: "error",
        text: friendlyError(cause, t).message,
      });
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={t("settings.manage.title")}
        title={t("resources.title")}
        subtitle={t("resources.subtitle")}
        actions={
          <div class="rs-header-actions">
            <Button
              type="button"
              variant="ghost"
              icon={<RefreshCw size={16} />}
              disabled={!scope()}
              onClick={() => {
                void refetchResources();
                void refetchTargetPools();
                void refetchSpacePolicies();
              }}
            >
              {t("common.refresh")}
            </Button>
            <Button
              type="button"
              variant="primary"
              icon={<Plus size={16} />}
              disabled={!scope() || featureUnavailable()}
              onClick={() => setShowEditor((value) => !value)}
            >
              {t("resources.define")}
            </Button>
          </div>
        }
      />

      <Show
        when={workspaceId()}
        fallback={
          <EmptyState
            icon={<Boxes size={28} />}
            title={t("workspace.select")}
            message={t("workspace.selectMessage")}
          />
        }
      >
        {(workspace) => (
          <div class="rs-view">
            <Card class="rs-scope-card">
              <CardHeader
                title={t("resources.scope.title")}
                subtitle={t("resources.scope.subtitle")}
              />
              <CardSection class="rs-scope-row">
                <dl class="tg-kv">
                  <dt>{t("workspace.label")}</dt>
                  <dd>{workspace()}</dd>
                  <dt>{t("resources.scope.label")}</dt>
                  <dd>{workspace()}</dd>
                </dl>
              </CardSection>
            </Card>

            <Show when={featureUnavailable()}>
              <EmptyState
                icon={<Settings2 size={28} />}
                title={t("resources.unavailable.title")}
                message={t("resources.unavailable.message")}
              />
            </Show>

            <Show when={!featureUnavailable() && showEditor() && scope()}>
              {(active) => (
                <ResourceEditor
                  workspaceId={active().workspaceId}
                  space={active().space}
                  onCancel={() => setShowEditor(false)}
                  onApplied={async () => {
                    setShowEditor(false);
                    await refetchResources();
                  }}
                />
              )}
            </Show>

            <Show when={!featureUnavailable()}>
              <section class="rs-section" aria-labelledby="rs-list-title">
                <div class="rs-section-title-row">
                  <div>
                    <h2 id="rs-list-title">{t("resources.inventory.title")}</h2>
                    <p>
                      {t("resources.inventory.subtitle", {
                        space: scope()?.space ?? "—",
                      })}
                    </p>
                  </div>
                </div>
                <DataTable
                  columns={resourceColumns}
                  rows={resources()}
                  rowKey={(resource) =>
                    `${resource.metadata.space}:${resource.kind}:${resource.metadata.name}`
                  }
                  loading={resources.loading}
                  error={
                    resources.error
                      ? t("common.fetchFailed", {
                          message: friendlyError(resources.error, t).message,
                        })
                      : undefined
                  }
                  empty={t("resources.empty")}
                />
              </section>

              <section class="rs-section" aria-labelledby="rs-pools-title">
                <div class="rs-section-title-row">
                  <div>
                    <h2 id="rs-pools-title">
                      {t("resources.targetPools.title")}
                    </h2>
                    <p>{t("resources.targetPools.subtitle")}</p>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    icon={<Plus size={16} />}
                    onClick={startTargetPool}
                  >
                    {t("resources.targetPools.add")}
                  </Button>
                </div>
                <DataTable
                  columns={poolColumns}
                  rows={targetPools()}
                  rowKey={(pool) => pool.id}
                  loading={targetPools.loading}
                  error={
                    targetPools.error
                      ? t("common.fetchFailed", {
                          message: friendlyError(targetPools.error, t).message,
                        })
                      : undefined
                  }
                  empty={t("resources.targetPools.empty")}
                />
                <Show when={poolMessage()}>
                  {(message) => (
                    <Toast tone={message().tone}>{message().text}</Toast>
                  )}
                </Show>
                <Show when={poolEditorOpen()}>
                  <Card class="rs-config-editor">
                    <CardHeader
                      title={t("resources.targetPools.editorTitle")}
                      actions={
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setPoolEditorOpen(false)}
                        >
                          {t("common.cancel")}
                        </Button>
                      }
                    />
                    <CardSection>
                      <label class="tg-field">
                        <span class="tg-field-label">
                          {t("resources.targetPools.name")}
                        </span>
                        <input
                          class="tg-input"
                          value={poolName()}
                          onInput={(event) =>
                            setPoolName(event.currentTarget.value)
                          }
                          autocomplete="off"
                        />
                      </label>
                      <label class="tg-field rs-json-field">
                        <span class="tg-field-label">
                          {t("resources.targetPools.spec")}
                        </span>
                        <textarea
                          class="tg-textarea rs-code-editor"
                          value={poolSpecText()}
                          rows={14}
                          spellcheck={false}
                          onInput={(event) =>
                            setPoolSpecText(event.currentTarget.value)
                          }
                        />
                        <span class="tg-field-hint">
                          {t("resources.config.noSecrets")}
                        </span>
                      </label>
                      <div class="rs-editor-actions">
                        <Button
                          type="button"
                          variant="primary"
                          busy={poolBusy()}
                          onClick={() => void saveTargetPool()}
                        >
                          {t("common.save")}
                        </Button>
                      </div>
                    </CardSection>
                  </Card>
                </Show>
              </section>

              <section class="rs-section" aria-labelledby="rs-policy-title">
                <details class="rs-policy-disclosure">
                  <summary>
                    <span>
                      <strong id="rs-policy-title">
                        {t("resources.policy.title")}
                      </strong>
                      <small>{t("resources.policy.subtitle")}</small>
                    </span>
                  </summary>
                  <div class="rs-section-title-row">
                    <span />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      icon={<Plus size={16} />}
                      onClick={startSpacePolicy}
                    >
                      {t("resources.policy.add")}
                    </Button>
                  </div>
                  <DataTable
                    columns={policyColumns}
                    rows={spacePolicies()}
                    rowKey={(policy) => policy.id}
                    loading={spacePolicies.loading}
                    error={
                      spacePolicies.error
                        ? t("common.fetchFailed", {
                            message: friendlyError(spacePolicies.error, t)
                              .message,
                          })
                        : undefined
                    }
                    empty={t("resources.policy.empty")}
                  />
                  <Show when={policyEditorOpen()}>
                    <Card class="rs-config-editor">
                      <CardHeader
                        title={t("resources.policy.editorTitle")}
                        actions={
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setPolicyEditorOpen(false)}
                          >
                            {t("common.cancel")}
                          </Button>
                        }
                      />
                      <CardSection>
                        <label class="tg-field">
                          <span class="tg-field-label">
                            {t("resources.policy.name")}
                          </span>
                          <input
                            class="tg-input"
                            value={policyName()}
                            onInput={(event) =>
                              setPolicyName(event.currentTarget.value)
                            }
                            autocomplete="off"
                          />
                        </label>
                        <label class="tg-field rs-json-field">
                          <span class="tg-field-label">
                            {t("resources.policy.spec")}
                          </span>
                          <textarea
                            class="tg-textarea rs-code-editor"
                            value={policySpecText()}
                            rows={14}
                            spellcheck={false}
                            onInput={(event) =>
                              setPolicySpecText(event.currentTarget.value)
                            }
                          />
                          <span class="tg-field-hint">
                            {t("resources.policy.writeOnlyHint")}
                          </span>
                        </label>
                        <div class="rs-editor-actions">
                          <Button
                            type="button"
                            variant="primary"
                            busy={policyBusy()}
                            onClick={() => void saveSpacePolicy()}
                          >
                            {t("common.save")}
                          </Button>
                        </div>
                        <Show when={policyMessage()}>
                          {(message) => (
                            <Toast tone={message().tone}>
                              {message().text}
                            </Toast>
                          )}
                        </Show>
                      </CardSection>
                    </Card>
                  </Show>
                </details>
              </section>
            </Show>
          </div>
        )}
      </Show>
    </>
  );
}
