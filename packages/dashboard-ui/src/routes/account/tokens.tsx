import { Title } from "@solidjs/meta";
import { Copy, KeyRound, Trash2 } from "lucide-solid";
import {
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import AppShell from "~/components/shell/AppShell";
import AuthGuard from "~/components/auth/AuthGuard";
import {
  createToken,
  type CreateTokenResult,
  listTokens,
  revokeToken,
} from "~/lib/api/tokens";
import { ApiError } from "~/lib/api/client";

export default function Tokens() {
  return (
    <>
      <Title>Personal access tokens — Takosumi</Title>
      <AuthGuard>{() => <Inner />}</AuthGuard>
    </>
  );
}

function Inner() {
  const [tokens, { refetch }] = createResource(() => listTokens());
  const [name, setName] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const [createError, setCreateError] = createSignal<string | null>(null);
  const [newToken, setNewToken] = createSignal<CreateTokenResult | null>(null);
  const [copied, setCopied] = createSignal(false);
  // In-app revoke confirmation + error surface (replaces native
  // confirm()/alert(), which is blocking, unstyled, and untestable).
  const [pendingRevoke, setPendingRevoke] = createSignal<string | null>(null);
  const [revoking, setRevoking] = createSignal(false);
  const [revokeError, setRevokeError] = createSignal<string | null>(null);

  const create = async (e: Event) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const t = await createToken({ name: name() });
      setNewToken(t);
      setName("");
      refetch();
    } catch (err) {
      setCreateError((err as ApiError).message);
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    setRevoking(true);
    setRevokeError(null);
    try {
      await revokeToken(id);
      setPendingRevoke(null);
      refetch();
    } catch (err) {
      setRevokeError((err as ApiError).message);
    } finally {
      setRevoking(false);
    }
  };

  const copy = async () => {
    const t = newToken();
    if (!t) return;
    await navigator.clipboard.writeText(t.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <AppShell>
      <div class="page-header">
        <h1>Personal access tokens</h1>
        <p class="page-sub">
          CLI や CI から Takosumi API を叩くためのトークン。
        </p>
      </div>

      <section class="detail-section">
        <h2>新しいトークン</h2>
        <form class="token-form" onSubmit={create}>
          <label>
            名前 (用途を識別する任意のラベル)
            <input
              type="text"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              placeholder="e.g. ci-deploy"
              required
            />
          </label>
          <button
            class="btn btn-primary"
            type="submit"
            disabled={creating() || !name()}
          >
            <KeyRound size={16} /> {creating() ? "発行中..." : "発行"}
          </button>
        </form>
        <Show when={createError()}>
          {(m) => <p class="sign-in-error">{m()}</p>}
        </Show>
        <Show when={newToken()}>
          {(t) => (
            <div class="token-issued">
              <div class="token-issued-head">
                <strong>トークンを発行しました</strong>
                <span class="muted">
                  この画面を閉じると 2 度と見られません。
                  必ずコピーしてください。
                </span>
              </div>
              <div class="token-issued-value">
                <code>{t().token}</code>
                <button class="btn btn-secondary" type="button" onClick={copy}>
                  <Copy size={14} /> {copied() ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}
        </Show>
      </section>

      <section class="detail-section">
        <h2>発行済み</h2>
        <Show when={revokeError()}>
          {(m) => <p class="sign-in-error">{m()}</p>}
        </Show>
        <Switch>
          <Match when={tokens.loading}>
            <div class="skel-block" />
          </Match>
          <Match when={tokens.error}>
            <p class="sign-in-error">{(tokens.error as ApiError).message}</p>
          </Match>
          <Match when={tokens()}>
            {(list) => (
              <Show
                when={list().length > 0}
                fallback={<p class="muted">まだトークンはありません。</p>}
              >
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>名前</th>
                      <th>Prefix</th>
                      <th>Scopes</th>
                      <th>作成</th>
                      <th>最終使用</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={list()}>
                      {(t) => (
                        <tr>
                          <td>{t.name}</td>
                          <td>
                            <code>{t.tokenPrefix}...</code>
                          </td>
                          <td>{(t.scopes ?? []).join(", ") || "—"}</td>
                          <td>{t.createdAt ?? "—"}</td>
                          <td>{t.lastUsedAt ?? "—"}</td>
                          <td>
                            <Show
                              when={pendingRevoke() === t.tokenId}
                              fallback={
                                <button
                                  class="btn-icon-danger"
                                  type="button"
                                  onClick={() => {
                                    setRevokeError(null);
                                    setPendingRevoke(t.tokenId);
                                  }}
                                  aria-label="revoke"
                                >
                                  <Trash2 size={14} />
                                </button>
                              }
                            >
                              <div class="revoke-confirm">
                                <span class="muted">失効しますか？</span>
                                <button
                                  class="btn btn-danger btn-sm"
                                  type="button"
                                  onClick={() => revoke(t.tokenId)}
                                  disabled={revoking()}
                                >
                                  {revoking() ? "失効中..." : "失効"}
                                </button>
                                <button
                                  class="btn btn-secondary btn-sm"
                                  type="button"
                                  onClick={() => setPendingRevoke(null)}
                                  disabled={revoking()}
                                >
                                  取消
                                </button>
                              </div>
                            </Show>
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
    </AppShell>
  );
}
