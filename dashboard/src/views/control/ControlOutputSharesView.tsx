import "../../styles/wave-b.css";
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
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import SpaceSelector from "./SpaceSelector.tsx";
import { currentSpaceId } from "./space-state.ts";
import {
  type ControlApiError,
  approveOutputShare,
  createOutputShare,
  listInstallations,
  listOutputShares,
  listSpaces,
  type OutputShare,
  revokeOutputShare,
} from "../../lib/control-api.ts";
import { createAction } from "../account/lib/action.tsx";
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
  PageHeader,
  Select,
  Textarea,
} from "../../components/ui/index.ts";

type OutputDraft = {
  readonly id: string;
  readonly name: string;
  readonly alias: string;
  readonly sensitive: boolean;
};

export default function ControlOutputSharesView() {
  return <Page title="Output shares">{() => <Inner />}</Page>;
}

function shareTone(status: OutputShare["status"]): "ok" | "warn" | "muted" {
  if (status === "active") return "ok";
  if (status === "revoked") return "muted";
  return "warn";
}

function Inner() {
  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);
  const [shares, { refetch }] = createResource(spaceId, listOutputShares);
  const [spaces] = createResource(listSpaces);
  const [installations] = createResource(spaceId, listInstallations);

  const [toSpaceId, setToSpaceId] = createSignal("");
  const [producerInstallationId, setProducerInstallationId] = createSignal("");
  const [outputs, setOutputs] = createSignal<readonly OutputDraft[]>([
    emptyOutputDraft(),
  ]);
  const [sensitiveReason, setSensitiveReason] = createSignal("");
  const [formError, setFormError] = createSignal<string | null>(null);

  const spaceName = createMemo(() => {
    const map = new Map<string, string>();
    for (const s of spaces() ?? []) map.set(s.id, `@${s.handle}`);
    return map;
  });

  const installationName = createMemo(() => {
    const map = new Map<string, string>();
    for (const inst of installations() ?? []) map.set(inst.id, inst.name);
    return map;
  });

  const create = createAction(async () => {
    setFormError(null);
    const from = spaceId();
    if (!from) throw new Error("Space を選択してください。");
    const entries = normalizeOutputDrafts(outputs());
    if (entries.length === 0) {
      setFormError("共有する output 名を 1 つ以上入力してください。");
      return;
    }
    const hasSensitive = entries.some((entry) => entry.sensitive === true);
    if (hasSensitive && !sensitiveReason().trim()) {
      setFormError("sensitive output を共有する理由を入力してください。");
      return;
    }
    await createOutputShare({
      fromSpaceId: from,
      toSpaceId: toSpaceId().trim(),
      producerInstallationId: producerInstallationId().trim(),
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
      rows.map((row) => row.id === id ? { ...row, ...patch } : row)
    );
  };

  const removeOutput = (id: string) => {
    setOutputs((rows) =>
      rows.length > 1
        ? rows.filter((row) => row.id !== id)
        : [emptyOutputDraft()]
    );
  };

  const sensitiveSelected = createMemo(() =>
    outputs().some((output) => output.sensitive)
  );

  const columns: readonly Column<OutputShare>[] = [
    {
      header: "方向",
      cell: (share) => (
        <span class="wb-mono">
          <code>{spaceName().get(share.fromSpaceId) ?? share.fromSpaceId}</code>
          <span class="muted"> → </span>
          <code>{spaceName().get(share.toSpaceId) ?? share.toSpaceId}</code>
        </span>
      ),
    },
    {
      header: "Installation",
      cell: (share) =>
        installationName().get(share.producerInstallationId) ??
        share.producerInstallationId,
    },
    {
      header: "Outputs",
      cell: (share) => (
        <ul class="wb-chips">
          <For each={share.outputs}>
            {(output) => (
              <li class="wb-chip">
                {output.name}
                <Show when={output.alias}>
                  {(alias) => <span class="muted"> as {alias()}</span>}
                </Show>
                <Show when={output.sensitive}>
                  <Badge tone="warn" class="wb-you-tag">sensitive</Badge>
                </Show>
              </li>
            )}
          </For>
        </ul>
      ),
    },
    {
      header: "状態",
      cell: (share) => <Badge tone={shareTone(share.status)}>{share.status}</Badge>,
    },
    {
      header: "",
      align: "right",
      cell: (share) => (
        <div class="wb-row-actions">
          <Show
            when={share.status === "pending" && share.toSpaceId === spaceId()}
          >
            <Button
              variant="primary"
              size="sm"
              busy={approve.busy()}
              disabled={approve.busy()}
              onClick={() => void approve.run(share.id)}
            >
              approve
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
              revoke
            </Button>
          </Show>
        </div>
      ),
    },
  ];

  return (
    <AppShell>
      <PageHeader
        eyebrow="CONTROL"
        title="Output shares"
        subtitle="Space 間で Installation の projected output を明示的に共有します。"
      />

      <SpaceSelector />

      <Show
        when={spaceId()}
        fallback={
          <EmptyState
            ink
            icon={<Share2 size={28} />}
            title="Space を選択"
            message="Space を選択すると OutputShare を表示します。"
          />
        }
      >
        <div class="wb-stack">
          <Card>
            <CardHeader title="共有を作成" />
            <CardSection>
              <form
                class="wb-install-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void create.run();
                }}
              >
                <div class="wb-form-row">
                  <FormField label="共有先 Space">
                    <Select
                      value={toSpaceId()}
                      onChange={(e) => setToSpaceId(e.currentTarget.value)}
                    >
                      <option value="">選択してください</option>
                      <For
                        each={(spaces() ?? []).filter((s) => s.id !== spaceId())}
                      >
                        {(space) => (
                          <option value={space.id}>
                            @{space.handle} — {space.displayName}
                          </option>
                        )}
                      </For>
                    </Select>
                  </FormField>
                  <FormField label="Producer Installation">
                    <Select
                      value={producerInstallationId()}
                      onChange={(e) =>
                        setProducerInstallationId(e.currentTarget.value)}
                    >
                      <option value="">選択してください</option>
                      <For each={installations() ?? []}>
                        {(inst) => (
                          <option value={inst.id}>
                            {inst.name} ({inst.environment})
                          </option>
                        )}
                      </For>
                    </Select>
                  </FormField>
                </div>

                <FormField label="Outputs">
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
                              })}
                            placeholder="base_domain"
                            autocomplete="off"
                            spellcheck={false}
                            aria-label="Output name"
                          />
                          <Input
                            type="text"
                            value={output.alias}
                            onInput={(e) =>
                              updateOutput(output.id, {
                                alias: e.currentTarget.value,
                              })}
                            placeholder="alias"
                            autocomplete="off"
                            spellcheck={false}
                            aria-label="Output alias"
                          />
                          <Checkbox
                            label="sensitive"
                            checked={output.sensitive}
                            onChange={(e) =>
                              updateOutput(output.id, {
                                sensitive: e.currentTarget.checked,
                              })}
                          />
                          <Button
                            variant="secondary"
                            size="sm"
                            type="button"
                            onClick={() => removeOutput(output.id)}
                          >
                            remove
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
                      setOutputs((rows) => [...rows, emptyOutputDraft()])}
                  >
                    output を追加
                  </Button>
                </FormField>

                <Show when={sensitiveSelected()}>
                  <FormField label="Sensitive sharing reason">
                    <Textarea
                      value={sensitiveReason()}
                      onInput={(e) => setSensitiveReason(e.currentTarget.value)}
                      rows={3}
                      placeholder="ticket / approval reason"
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
                    共有を作成
                  </Button>
                </div>
                <Show when={formError()}>
                  {(m) => <p class="wb-error" role="alert">{m()}</p>}
                </Show>
                <Show when={create.error()}>
                  {(m) => <p class="wb-error" role="alert">{m()}</p>}
                </Show>
                <Show when={approve.error()}>
                  {(m) => <p class="wb-error" role="alert">{m()}</p>}
                </Show>
                <Show when={revoke.error()}>
                  {(m) => <p class="wb-error" role="alert">{m()}</p>}
                </Show>
              </form>
            </CardSection>
          </Card>

          <section class="wb-stack-tight">
            <h2 class="tg-card-title">共有一覧</h2>
            <Switch>
              <Match when={shares.error}>
                <EmptyState
                  icon={<Share2 size={28} />}
                  title="取得に失敗しました"
                  message={(shares.error as ControlApiError).message}
                />
              </Match>
              <Match when={!shares.error}>
                <Show
                  when={shares.loading || (shares()?.length ?? 0) > 0}
                  fallback={
                    <EmptyState
                      ink
                      icon={<Share2 size={28} />}
                      title="共有はまだありません"
                      message="OutputShare はまだありません。"
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
      </Show>
    </AppShell>
  );
}

function emptyOutputDraft(): OutputDraft {
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `out_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    name: "",
    alias: "",
    sensitive: false,
  };
}

function normalizeOutputDrafts(
  rows: readonly OutputDraft[],
): readonly {
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
