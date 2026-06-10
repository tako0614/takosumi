/**
 * Members view — Space メンバー管理 (spec §4 / membership domain).
 *
 * Backs the session-authed `/v1/control/spaces/:id/members[/:subject]` routes
 * (see packages/accounts-service/src/control-routes.ts). The Space is resolved
 * server-side from the path and the membership-ROLE gate is enforced by the
 * backend; this view mirrors that gate in the UI so a non-owner never sees a
 * dead mutation control:
 *
 *   - 一覧 (list):        どのメンバーでも閲覧できる。
 *   - 招待/追加 (invite): owner / admin のみ。
 *   - 役割の変更 (role):  owner のみ。
 *   - 削除 (remove):      owner のみ。最後の owner は降格も削除もできない。
 *
 * IMPORTANT: the UI gate is convenience only. The server re-checks every
 * mutation from the membership ledger itself (and never trusts the spaceId from
 * a body), so a forged request still fails closed. The membership domain has no
 * email-invite or notification side-channel, so 招待 here adds an EXISTING
 * account handle / subject directly as an active member.
 */
import {
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { ShieldCheck, Trash2, UserPlus } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import SpaceSelector from "./SpaceSelector.tsx";
import { currentSpaceId } from "./space-state.ts";
import {
  type ControlApiError,
  type ControlSpaceRole,
  inviteMember,
  listMembers,
  type PublicSpaceMember,
  removeMember,
  setMemberRole,
} from "../../lib/control-api.ts";
import type { SessionRecord } from "../account/lib/session.ts";
import { createAction } from "../account/lib/action.tsx";

/** 平易日本語の役割ラベル (owner/admin/member/viewer)。 */
const ROLE_LABEL: Record<ControlSpaceRole, string> = {
  owner: "オーナー",
  admin: "管理者",
  member: "メンバー",
  viewer: "閲覧のみ",
};

const ROLE_ORDER: readonly ControlSpaceRole[] = [
  "owner",
  "admin",
  "member",
  "viewer",
];

const STATUS_LABEL: Record<PublicSpaceMember["status"], string> = {
  active: "有効",
  invited: "招待中",
  suspended: "削除済み",
};

function rolesLabel(roles: readonly ControlSpaceRole[]): string {
  if (roles.length === 0) return "—";
  return roles.map((r) => ROLE_LABEL[r]).join("・");
}

export default function ControlMembersView() {
  return (
    <Page title="メンバー">
      {(session) => <Inner session={session} />}
    </Page>
  );
}

function Inner(props: { readonly session: SessionRecord }) {
  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);
  const [members, { refetch }] = createResource(spaceId, listMembers);
  // The signed-in caller's account subject (from the auth-gated Page session).
  // The membership ledger matches a member by `accountId === subject`, so this
  // locates the caller in the roster and decides which mutation controls show.
  const callerSubject = () => props.session.subject;

  const caller = (): PublicSpaceMember | undefined => {
    const subject = callerSubject();
    if (!subject) return undefined;
    return (members() ?? []).find((m) => m.accountId === subject);
  };
  const callerRoles = (): readonly ControlSpaceRole[] =>
    caller()?.status === "active" ? (caller()?.roles ?? []) : [];
  // owner/admin gate (招待) と owner-only gate (役割変更・削除) を UI に反映。
  const canInvite = () =>
    callerRoles().includes("owner") || callerRoles().includes("admin");
  const canManage = () => callerRoles().includes("owner");
  // owner だけが owner ロールを付与できる (admin は不可)。
  const callerIsOwner = () => callerRoles().includes("owner");

  const activeOwnerCount = () =>
    (members() ?? []).filter(
      (m) => m.status === "active" && m.roles.includes("owner"),
    ).length;

  // --- 招待 (既存アカウントを member として追加) ---
  const [inviteAccount, setInviteAccount] = createSignal("");
  const [inviteRole, setInviteRole] = createSignal<ControlSpaceRole>("member");
  const invite = createAction(async () => {
    const id = spaceId();
    if (!id) throw new Error("Space を選択してください。");
    const account = inviteAccount().trim();
    if (!account) throw new Error("ハンドルかアカウント ID を入力してください。");
    await inviteMember(id, { accountId: account, role: inviteRole() });
    setInviteAccount("");
    setInviteRole("member");
    await refetch();
  });

  // --- 役割の変更 (owner のみ) ---
  const changeRole = createAction(
    async (member: PublicSpaceMember, role: ControlSpaceRole) => {
      const id = spaceId();
      if (!id) throw new Error("Space を選択してください。");
      await setMemberRole(id, member.accountId, role);
      await refetch();
    },
  );

  // --- 削除 (owner のみ、soft-remove) ---
  const remove = createAction(async (member: PublicSpaceMember) => {
    const id = spaceId();
    if (!id) throw new Error("Space を選択してください。");
    if (
      typeof globalThis.confirm === "function" &&
      !globalThis.confirm(
        `このメンバーを削除しますか？ (${member.accountId})`,
      )
    ) {
      return;
    }
    await removeMember(id, member.accountId);
    await refetch();
  });

  /** その行の owner を降格/削除すると Space が無管理になる場合 true。 */
  const isLastOwner = (member: PublicSpaceMember) =>
    member.status === "active" &&
    member.roles.includes("owner") &&
    activeOwnerCount() <= 1;

  return (
    <AppShell>
      <div class="page-header">
        <h1>メンバー</h1>
        <p class="page-sub">
          この Space のメンバーと役割を管理します。招待・役割の変更・削除は
          オーナーまたは管理者のみ行えます。
        </p>
      </div>

      <SpaceSelector />

      <Show
        when={spaceId()}
        fallback={
          <section class="empty-state">
            <p>Space を選択するとメンバー一覧を表示します。</p>
          </section>
        }
      >
        {/* 招待フォーム — owner/admin のみ表示。 */}
        <Show when={canInvite()}>
          <section class="card member-invite">
            <h2>メンバーを招待</h2>
            <p class="muted">
              既存のアカウントのハンドル（@なし）またはアカウント ID を入力すると、
              この Space のメンバーとして追加します。メール招待は未対応です。
            </p>
            <form
              class="member-invite-form"
              onSubmit={(e) => {
                e.preventDefault();
                void invite.run();
              }}
            >
              <label class="form-field">
                ハンドル / アカウント ID
                <input
                  type="text"
                  value={inviteAccount()}
                  onInput={(e) => setInviteAccount(e.currentTarget.value)}
                  placeholder="alice"
                  autocomplete="off"
                  spellcheck={false}
                />
              </label>
              <label class="form-field">
                役割
                <select
                  value={inviteRole()}
                  onChange={(e) =>
                    setInviteRole(e.currentTarget.value as ControlSpaceRole)
                  }
                >
                  <For each={ROLE_ORDER}>
                    {(role) => (
                      // owner ロールの付与は owner のみ。admin は選べない。
                      <Show when={role !== "owner" || callerIsOwner()}>
                        <option value={role}>{ROLE_LABEL[role]}</option>
                      </Show>
                    )}
                  </For>
                </select>
              </label>
              <button
                class="btn btn-primary"
                type="submit"
                disabled={invite.busy()}
              >
                <UserPlus size={16} />
                招待
              </button>
            </form>
            <Show when={invite.error()}>
              {(m) => <p class="sign-in-error">{m()}</p>}
            </Show>
          </section>
        </Show>

        <Show when={changeRole.error()}>
          {(m) => <p class="sign-in-error">{m()}</p>}
        </Show>
        <Show when={remove.error()}>
          {(m) => <p class="sign-in-error">{m()}</p>}
        </Show>

        <Switch>
          <Match when={members.loading}>
            <div class="grid-skel"><div class="skel-block" /></div>
          </Match>
          <Match when={members.error}>
            <section class="empty-state error-state">
              <p>
                取得に失敗しました — {(members.error as ControlApiError).message}
              </p>
            </section>
          </Match>
          <Match when={members()}>
            {(list) => (
              <Show
                when={list().length > 0}
                fallback={
                  <section class="empty-state">
                    <p>まだメンバーがいません。</p>
                  </section>
                }
              >
                <table class="data-table members-table">
                  <thead>
                    <tr>
                      <th>メンバー</th>
                      <th>役割</th>
                      <th>状態</th>
                      <Show when={canManage()}>
                        <th>操作</th>
                      </Show>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={list()}>
                      {(member) => (
                        <tr>
                          <td>
                            <code>{member.accountId}</code>
                            <Show when={member.accountId === callerSubject()}>
                              <span class="badge">あなた</span>
                            </Show>
                          </td>
                          <td>{rolesLabel(member.roles)}</td>
                          <td>
                            <span class="muted">
                              {STATUS_LABEL[member.status]}
                            </span>
                          </td>
                          {/* 役割変更・削除は owner のみ。閲覧者には列ごと出さない。 */}
                          <Show when={canManage()}>
                            <td class="members-actions">
                              <Show
                                when={member.status === "active"}
                                fallback={<span class="muted">—</span>}
                              >
                                <label class="members-role-select">
                                  <ShieldCheck size={14} />
                                  <select
                                    disabled={
                                      changeRole.busy() || isLastOwner(member)
                                    }
                                    value={member.roles[0] ?? "member"}
                                    onChange={(e) =>
                                      void changeRole.run(
                                        member,
                                        e.currentTarget.value as ControlSpaceRole,
                                      )
                                    }
                                    title={
                                      isLastOwner(member)
                                        ? "最後のオーナーは降格できません。先に別のオーナーを指名してください。"
                                        : "役割を変更"
                                    }
                                  >
                                    <For each={ROLE_ORDER}>
                                      {(role) => (
                                        <option value={role}>
                                          {ROLE_LABEL[role]}
                                        </option>
                                      )}
                                    </For>
                                  </select>
                                </label>
                                <button
                                  class="btn btn-danger btn-sm"
                                  type="button"
                                  disabled={remove.busy() || isLastOwner(member)}
                                  title={
                                    isLastOwner(member)
                                      ? "最後のオーナーは削除できません。先に別のオーナーを指名してください。"
                                      : "メンバーを削除"
                                  }
                                  onClick={() => void remove.run(member)}
                                >
                                  <Trash2 size={14} />
                                  削除
                                </button>
                              </Show>
                            </td>
                          </Show>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
            )}
          </Match>
        </Switch>

        {/* オーナーでない閲覧者向けの注記。 */}
        <Show when={members() && !canInvite()}>
          <p class="muted">
            メンバーの招待・役割変更・削除はオーナーまたは管理者のみ行えます。
          </p>
        </Show>
      </Show>
    </AppShell>
  );
}
