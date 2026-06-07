import {
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import StatusPill from "../account/components/StatusPill.tsx";
import SpaceSelector from "./SpaceSelector.tsx";
import { currentSpaceId } from "./space-state.ts";
import {
  type ControlApiError,
  approveOutputShare,
  createOutputShare,
  listInstallations,
  listOutputShares,
  listSpaces,
  revokeOutputShare,
} from "../../lib/control-api.ts";
import { createAction } from "../account/lib/action.tsx";

type OutputDraft = {
  readonly id: string;
  readonly name: string;
  readonly alias: string;
  readonly sensitive: boolean;
};

export default function ControlOutputSharesView() {
  return <Page title="Output shares">{() => <Inner />}</Page>;
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

  return (
    <AppShell>
      <div class="page-header">
        <h1>Output shares</h1>
        <p class="page-sub">
          Space 間で Installation の projected output を明示的に共有します。
        </p>
      </div>

      <SpaceSelector />

      <Show
        when={spaceId()}
        fallback={
          <section class="empty-state">
            <p>Space を選択すると OutputShare を表示します。</p>
          </section>
        }
      >
        <section class="detail-section">
          <h2>共有を作成</h2>
          <form
            class="install-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create.run();
            }}
          >
            <div class="install-form-row">
              <label class="form-field">
                共有先 Space
                <select
                  value={toSpaceId()}
                  onChange={(e) => setToSpaceId(e.currentTarget.value)}
                >
                  <option value="">選択してください</option>
                  <For each={(spaces() ?? []).filter((s) => s.id !== spaceId())}>
                    {(space) => (
                      <option value={space.id}>
                        @{space.handle} — {space.displayName}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <label class="form-field">
                Producer Installation
                <select
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
                </select>
              </label>
            </div>

            <div class="form-field">
              Outputs
              <div class="output-share-editor">
                <For each={outputs()}>
                  {(output) => (
                    <div class="output-share-row">
                      <input
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
                      <input
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
                      <label class="output-share-sensitive">
                        <input
                          type="checkbox"
                          checked={output.sensitive}
                          onChange={(e) =>
                            updateOutput(output.id, {
                              sensitive: e.currentTarget.checked,
                            })}
                        />
                        sensitive
                      </label>
                      <button
                        class="btn btn-secondary btn-sm"
                        type="button"
                        onClick={() => removeOutput(output.id)}
                      >
                        remove
                      </button>
                    </div>
                  )}
                </For>
              </div>
              <button
                class="btn btn-secondary btn-sm"
                type="button"
                onClick={() =>
                  setOutputs((rows) => [...rows, emptyOutputDraft()])}
              >
                output を追加
              </button>
            </div>

            <Show when={sensitiveSelected()}>
              <label class="form-field">
                Sensitive sharing reason
                <textarea
                  value={sensitiveReason()}
                  onInput={(e) => setSensitiveReason(e.currentTarget.value)}
                  rows={3}
                  placeholder="ticket / approval reason"
                  spellcheck={false}
                />
              </label>
            </Show>

            <div class="form-actions">
              <button
                class="btn btn-primary"
                type="submit"
                disabled={create.busy()}
              >
                {create.busy() ? "作成中..." : "共有を作成"}
              </button>
            </div>
            <Show when={formError()}>
              {(m) => <p class="sign-in-error">{m()}</p>}
            </Show>
            <Show when={create.error()}>
              {(m) => <p class="sign-in-error">{m()}</p>}
            </Show>
            <Show when={approve.error()}>
              {(m) => <p class="sign-in-error">{m()}</p>}
            </Show>
            <Show when={revoke.error()}>
              {(m) => <p class="sign-in-error">{m()}</p>}
            </Show>
          </form>
        </section>

        <Switch>
          <Match when={shares.loading}>
            <div class="grid-skel"><div class="skel-card" /></div>
          </Match>
          <Match when={shares.error}>
            <section class="empty-state error-state">
              <p>取得に失敗しました — {(shares.error as ControlApiError).message}</p>
            </section>
          </Match>
          <Match when={shares()}>
            {(list) => (
              <section class="detail-section">
                <h2>共有一覧</h2>
                <Show
                  when={list().length > 0}
                  fallback={<p class="muted">OutputShare はまだありません。</p>}
                >
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th>方向</th>
                        <th>Installation</th>
                        <th>Outputs</th>
                        <th>状態</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      <For each={list()}>
                        {(share) => (
                          <tr>
                            <td>
                              <code>
                                {spaceName().get(share.fromSpaceId) ??
                                  share.fromSpaceId}
                              </code>
                              <span class="muted"> → </span>
                              <code>
                                {spaceName().get(share.toSpaceId) ??
                                  share.toSpaceId}
                              </code>
                            </td>
                            <td>
                              {installationName().get(
                                share.producerInstallationId,
                              ) ?? share.producerInstallationId}
                            </td>
                            <td>
                              <ul class="depends-on-list">
                                <For each={share.outputs}>
                                  {(output) => (
                                    <li>
                                      <code>{output.name}</code>
                                      <Show when={output.alias}>
                                        {(alias) => (
                                          <span class="muted">
                                            {" "}as <code>{alias()}</code>
                                          </span>
                                        )}
                                      </Show>
                                      <Show when={output.sensitive}>
                                        <span
                                          class="output-badge"
                                          title="sensitive output value is never displayed"
                                        >
                                          sensitive
                                        </span>
                                      </Show>
                                    </li>
                                  )}
                                </For>
                              </ul>
                            </td>
                            <td>
                              <StatusPill
                                class={share.status === "active"
                                  ? "status-ready"
                                  : share.status === "revoked"
                                  ? "status-suspended"
                                  : "status-installing"}
                              >
                                {share.status}
                              </StatusPill>
                            </td>
                            <td class="installation-row-actions">
                              <Show
                                when={share.status === "pending" &&
                                  share.toSpaceId === spaceId()}
                              >
                                <button
                                  class="btn btn-primary btn-sm"
                                  type="button"
                                  disabled={approve.busy()}
                                  onClick={() => void approve.run(share.id)}
                                >
                                  approve
                                </button>
                              </Show>
                              <Show when={share.status !== "revoked"}>
                                <button
                                  class="btn btn-danger btn-sm"
                                  type="button"
                                  disabled={revoke.busy()}
                                  onClick={() => void revoke.run(share.id)}
                                >
                                  revoke
                                </button>
                              </Show>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </section>
            )}
          </Match>
        </Switch>
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
