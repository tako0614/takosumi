/**
 * Workspace settings — shared values. Port of the former ControlOutputSharesView
 * body: explicit cross-Workspace value shares (create / approve / revoke).
 */
import "../../../styles/wave-b.css";
import {
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { Share2 } from "lucide-solid";
import { listCapsulesCached } from "../../../lib/capsule-list.ts";
import {
  type ControlApiError,
  approveOutputShare,
  createOutputShare,
  listOutputShares,
  listWorkspaces,
  type OutputShare,
  revokeOutputShare,
} from "../../../lib/control-api.ts";
import { createAction } from "../../account/lib/action.tsx";
import { type MessageKey, t } from "../../../i18n/index.ts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardSection,
  Checkbox,
  type Column,
  DataTable,
  EmptyState,
  FormField,
  Input,
  Select,
  Textarea,
} from "../../../components/ui/index.ts";

type OutputDraft = {
  readonly id: string;
  readonly name: string;
  readonly alias: string;
  readonly sensitive: boolean;
};

function shareTone(status: OutputShare["status"]): "ok" | "warn" | "muted" {
  if (status === "active") return "ok";
  if (status === "revoked") return "muted";
  return "warn";
}

const SHARE_STATUS_KEY: Record<string, MessageKey> = {
  active: "shares.status.active",
  pending: "shares.status.pending",
  revoked: "shares.status.revoked",
};

function shareStatusLabel(status: string): string {
  const key = SHARE_STATUS_KEY[status];
  return key ? t(key) : status;
}

export default function SharesTab(props: { readonly workspaceId: string }) {
  const workspaceId = () => props.workspaceId;
  const [shares, { refetch }] = createResource(workspaceId, listOutputShares);
  const [workspaces] = createResource(listWorkspaces);
  const [capsules] = createResource(workspaceId, (id) =>
    listCapsulesCached(id, { includeDestroyed: false }),
  );

  const [toWorkspaceId, setToWorkspaceId] = createSignal("");
  const [producerCapsuleId, setProducerCapsuleId] = createSignal("");
  const [outputs, setOutputs] = createSignal<readonly OutputDraft[]>([
    emptyOutputDraft(),
  ]);
  const [sensitiveReason, setSensitiveReason] = createSignal("");
  const [formError, setFormError] = createSignal<string | null>(null);

  const workspaceName = createMemo(() => {
    const map = new Map<string, string>();
    for (const s of workspaces() ?? []) map.set(s.id, `@${s.handle}`);
    return map;
  });

  const capsuleName = createMemo(() => {
    const map = new Map<string, string>();
    for (const inst of capsules() ?? []) map.set(inst.id, inst.name);
    return map;
  });

  const create = createAction(async () => {
    setFormError(null);
    const entries = normalizeOutputDrafts(outputs());
    if (entries.length === 0) {
      setFormError(t("shares.error.outputsRequired"));
      return;
    }
    const hasSensitive = entries.some((entry) => entry.sensitive === true);
    if (hasSensitive && !sensitiveReason().trim()) {
      setFormError(t("shares.error.reasonRequired"));
      return;
    }
    await createOutputShare({
      fromWorkspaceId: workspaceId(),
      toWorkspaceId: toWorkspaceId().trim(),
      producerCapsuleId: producerCapsuleId().trim(),
      outputs: entries,
      ...(hasSensitive
        ? {
            sensitivePolicy: {
              allow: true,
              reason: sensitiveReason().trim(),
            },
          }
        : {}),
    });
    setOutputs([emptyOutputDraft()]);
    setSensitiveReason("");
    await refetch();
  });

  const approve = createAction(async (id: string) => {
    await approveOutputShare(id);
    await refetch();
  });

  const revoke = createAction(async (id: string) => {
    await revokeOutputShare(id);
    await refetch();
  });

  const updateOutput = (
    id: string,
    patch: Partial<Omit<OutputDraft, "id">>,
  ) => {
    setOutputs((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  };

  const removeOutput = (id: string) => {
    setOutputs((rows) =>
      rows.length > 1
        ? rows.filter((row) => row.id !== id)
        : [emptyOutputDraft()],
    );
  };

  const sensitiveSelected = createMemo(() =>
    outputs().some((output) => output.sensitive),
  );

  const columns: readonly Column<OutputShare>[] = [
    {
      header: t("shares.col.direction"),
      cell: (share) => {
        const from = share.fromWorkspaceId ?? share.fromSpaceId;
        const to = share.toWorkspaceId ?? share.toSpaceId;
        return (
          <span class="wb-mono">
            <code>{workspaceName().get(from) ?? from}</code>
            <span class="muted"> → </span>
            <code>{workspaceName().get(to) ?? to}</code>
          </span>
        );
      },
    },
    {
      header: t("shares.col.capsule"),
      cell: (share) => {
        const producer = share.producerCapsuleId ?? share.producerInstallationId;
        return capsuleName().get(producer) ?? producer;
      },
    },
    {
      header: t("shares.col.outputs"),
      cell: (share) => (
        <ul class="wb-chips">
          <For each={share.outputs}>
            {(output) => (
              <li class="wb-chip">
                {output.name}
                <Show when={output.alias}>
                  {(alias) => (
                    <span class="muted">
                      {" "}
                      {t("shares.create.outputAlias")} {alias()}
                    </span>
                  )}
                </Show>
                <Show when={output.sensitive}>
                  <Badge tone="warn" class="wb-you-tag">
                    {t("shares.create.sensitiveValue")}
                  </Badge>
                </Show>
              </li>
            )}
          </For>
        </ul>
      ),
    },
    {
      header: t("shares.col.status"),
      cell: (share) => (
        <Badge tone={shareTone(share.status)}>
          {shareStatusLabel(share.status)}
        </Badge>
      ),
    },
    {
      header: "",
      align: "right",
      cell: (share) => (
        <div class="wb-row-actions">
          <Show
            when={
              share.status === "pending" &&
              (share.toWorkspaceId ?? share.toSpaceId) === workspaceId()
            }
          >
            <Button
              variant="primary"
              size="sm"
              busy={approve.busy()}
              disabled={approve.busy()}
              onClick={() => void approve.run(share.id)}
            >
              {t("shares.approve")}
            </Button>
          </Show>
          <Show when={share.status !== "revoked"}>
            <Button
              variant="danger"
              size="sm"
              busy={revoke.busy()}
              disabled={revoke.busy()}
              onClick={() => void revoke.run(share.id)}
            >
              {t("shares.revoke")}
            </Button>
          </Show>
        </div>
      ),
    },
  ];

  return (
    <div class="wb-stack">
      <details class="wb-disclosure">
        <summary>{t("shares.create.title")}</summary>
        <Card>
          <CardHeader
            title={t("shares.create.title")}
            subtitle={t("shares.subtitle")}
          />
          <CardSection>
            <form
              class="wb-install-form"
              onSubmit={(e) => {
                e.preventDefault();
                void create.run();
              }}
            >
              <div class="wb-form-row">
                <FormField label={t("shares.create.toWorkspace")}>
                  <Select
                    value={toWorkspaceId()}
                    onChange={(e) => setToWorkspaceId(e.currentTarget.value)}
                  >
                    <option value="">
                      {t("shares.create.selectPlaceholder")}
                    </option>
                    <For
                      each={(workspaces() ?? []).filter((s) => s.id !== workspaceId())}
                    >
                      {(workspace) => (
                        <option value={workspace.id}>
                          @{workspace.handle} — {workspace.displayName}
                        </option>
                      )}
                    </For>
                  </Select>
                </FormField>
                <FormField label={t("shares.create.producer")}>
                  <Select
                    value={producerCapsuleId()}
                    onChange={(e) =>
                      setProducerCapsuleId(e.currentTarget.value)
                    }
                  >
                    <option value="">
                      {t("shares.create.selectPlaceholder")}
                    </option>
                    <For each={capsules() ?? []}>
                      {(inst) => (
                        <option value={inst.id}>
                          {inst.name} ({inst.environment})
                        </option>
                      )}
                    </For>
                  </Select>
                </FormField>
              </div>

              <FormField label={t("shares.create.outputs")}>
                <div class="wb-output-editor">
                  <For each={outputs()}>
                    {(output) => (
                      <div class="wb-output-row">
                        <Input
                          type="text"
                          value={output.name}
                          onInput={(e) =>
                            updateOutput(output.id, {
                              name: e.currentTarget.value,
                            })
                          }
                          placeholder="base_domain"
                          autocomplete="off"
                          spellcheck={false}
                          aria-label={t("shares.create.outputName")}
                        />
                        <Input
                          type="text"
                          value={output.alias}
                          onInput={(e) =>
                            updateOutput(output.id, {
                              alias: e.currentTarget.value,
                            })
                          }
                          placeholder="alias"
                          autocomplete="off"
                          spellcheck={false}
                          aria-label={t("shares.create.outputAlias")}
                        />
                        <Checkbox
                          label={t("shares.create.sensitiveValue")}
                          checked={output.sensitive}
                          onChange={(e) =>
                            updateOutput(output.id, {
                              sensitive: e.currentTarget.checked,
                            })
                          }
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          type="button"
                          onClick={() => removeOutput(output.id)}
                        >
                          {t("shares.create.removeOutput")}
                        </Button>
                      </div>
                    )}
                  </For>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() =>
                    setOutputs((rows) => [...rows, emptyOutputDraft()])
                  }
                >
                  {t("shares.create.addOutput")}
                </Button>
              </FormField>

              <Show when={sensitiveSelected()}>
                <FormField label={t("shares.create.sensitiveReason")}>
                  <Textarea
                    value={sensitiveReason()}
                    onInput={(e) => setSensitiveReason(e.currentTarget.value)}
                    rows={3}
                    placeholder={t("shares.create.sensitivePlaceholder")}
                    spellcheck={false}
                  />
                </FormField>
              </Show>

              <div class="wb-form-actions">
                <Button
                  variant="primary"
                  type="submit"
                  busy={create.busy()}
                  disabled={create.busy()}
                >
                  {t("shares.create.cta")}
                </Button>
              </div>
              <Show when={formError()}>
                {(m) => (
                  <p class="wb-error" role="alert">
                    {m()}
                  </p>
                )}
              </Show>
              <Show when={create.error()}>
                {(m) => (
                  <p class="wb-error" role="alert">
                    {m()}
                  </p>
                )}
              </Show>
              <Show when={approve.error()}>
                {(m) => (
                  <p class="wb-error" role="alert">
                    {m()}
                  </p>
                )}
              </Show>
              <Show when={revoke.error()}>
                {(m) => (
                  <p class="wb-error" role="alert">
                    {m()}
                  </p>
                )}
              </Show>
            </form>
          </CardSection>
        </Card>
      </details>

      <section class="wb-stack-tight">
        <h2 class="tg-card-title">{t("shares.list.title")}</h2>
        <Switch>
          <Match when={shares.error}>
            <EmptyState
              icon={<Share2 size={28} />}
              title={t("workspaceSettings.tab.shares")}
              message={t("common.fetchFailed", {
                message: (shares.error as ControlApiError).message,
              })}
            />
          </Match>
          <Match when={!shares.error}>
            <Show
              when={shares.loading || (shares()?.length ?? 0) > 0}
              fallback={
                <EmptyState
                  icon={<Share2 size={28} />}
                  title={t("workspaceSettings.tab.shares")}
                  message={t("shares.empty")}
                />
              }
            >
              <DataTable
                columns={columns}
                rows={shares()}
                rowKey={(share) => share.id}
                loading={shares.loading}
                skeletonRows={3}
              />
            </Show>
          </Match>
        </Switch>
      </section>
    </div>
  );
}

function emptyOutputDraft(): OutputDraft {
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `out_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    name: "",
    alias: "",
    sensitive: false,
  };
}

function normalizeOutputDrafts(rows: readonly OutputDraft[]): readonly {
  readonly name: string;
  readonly alias?: string;
  readonly sensitive?: boolean;
}[] {
  return rows
    .map((row) => ({
      name: row.name.trim(),
      alias: row.alias.trim(),
      sensitive: row.sensitive,
    }))
    .filter((row) => row.name.length > 0)
    .map((row) => ({
      name: row.name,
      ...(row.alias ? { alias: row.alias } : {}),
      ...(row.sensitive ? { sensitive: true } : {}),
    }));
}
