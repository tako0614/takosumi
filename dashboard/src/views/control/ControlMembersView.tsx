/**
 * Members view — Space メンバー管理 (spec §4 / membership domain).
 *
 * Backs the session-authed `/api/v1/spaces/:id/members[/:subject]` routes
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
import { ShieldCheck, Trash2, UserPlus, Users } from "lucide-solid";
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
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardSection,
  type Column,
  DataTable,
  EmptyState,
  FormField,
  Input,
  PageHeader,
  Select,
} from "../../components/ui/index.ts";

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

function statusTone(status: PublicSpaceMember["status"]): "ok" | "info" | "muted" {
  if (status === "active") return "ok";
  if (status === "invited") return "info";
  return "muted";
}

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

  const columns = createMemo<readonly Column<PublicSpaceMember>[]>(() => {
    const base: Column<PublicSpaceMember>[] = [
      {
        header: "メンバー",
        cell: (member) => (
          <>
            <code class="wb-mono">{member.accountId}</code>
            <Show when={member.accountId === callerSubject()}>
              <Badge tone="info" class="wb-you-tag">あなた</Badge>
            </Show>
          </>
        ),
      },
      {
        header: "役割",
        cell: (member) => rolesLabel(member.roles),
      },
      {
        header: "状態",
        cell: (member) => (
          <Badge tone={statusTone(member.status)}>
            {STATUS_LABEL[member.status]}
          </Badge>
        ),
      },
    ];
    if (canManage()) {
      base.push({
        header: "操作",
        align: "right",
        // The 操作 column (役割変更・削除) is owner-only; the inner gate mirrors
        // the column-level <Show when={canManage()}> for an extra fail-closed
        // backstop in the access-control-sensitive membership surface.
        cell: (member) => (
          <Show when={canManage()} fallback={<span class="muted">—</span>}>
            <Show
              when={member.status === "active"}
              fallback={<span class="muted">—</span>}
            >
              <div class="wb-members-actions">
              <label class="wb-role-select">
                <ShieldCheck size={14} />
                <Select
                  disabled={changeRole.busy() || isLastOwner(member)}
                  value={member.roles[0] ?? "member"}
                  onChange={(e) =>
                    void changeRole.run(
                      member,
                      e.currentTarget.value as ControlSpaceRole,
                    )}
                  title={
                    isLastOwner(member)
                      ? "最後のオーナーは降格できません。先に別のオーナーを指名してください。"
                      : "役割を変更"
                  }
                >
                  <For each={ROLE_ORDER}>
                    {(role) => <option value={role}>{ROLE_LABEL[role]}</option>}
                  </For>
                </Select>
              </label>
              <Button
                variant="danger"
                size="sm"
                icon={<Trash2 size={14} />}
                disabled={remove.busy() || isLastOwner(member)}
                title={
                  isLastOwner(member)
                    ? "最後のオーナーは削除できません。先に別のオーナーを指名してください。"
                    : "メンバーを削除"
                }
                onClick={() => void remove.run(member)}
              >
                削除
              </Button>
              </div>
            </Show>
          </Show>
        ),
      });
    }
    return base;
  });

  return (
    <AppShell>
      <PageHeader
        eyebrow="CONTROL"
        title="メンバー"
        subtitle="この Space のメンバーと役割を管理します。招待・役割の変更・削除はオーナーまたは管理者のみ行えます。"
      />

      <SpaceSelector />

      <Show
        when={spaceId()}
        fallback={
          <EmptyState
            ink
            icon={<Users size={28} />}
            title="Space を選択"
            message="Space を選択するとメンバー一覧を表示します。"
          />
        }
      >
        <div class="wb-stack">
          {/* 招待フォーム — owner/admin のみ表示。 */}
          <Show when={canInvite()}>
            <Card>
              <CardHeader
                title="メンバーを招待"
                subtitle="既存のアカウントのハンドル（@なし）またはアカウント ID を入力すると、この Space のメンバーとして追加します。メール招待は未対応です。"
              />
              <CardSection>
                <form
                  class="wb-invite-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void invite.run();
                  }}
                >
                  <FormField label="ハンドル / アカウント ID">
                    <Input
                      type="text"
                      value={inviteAccount()}
                      onInput={(e) => setInviteAccount(e.currentTarget.value)}
                      placeholder="alice"
                      autocomplete="off"
                      spellcheck={false}
                    />
                  </FormField>
                  <FormField label="役割">
                    <Select
                      value={inviteRole()}
                      onChange={(e) =>
                        setInviteRole(e.currentTarget.value as ControlSpaceRole)}
                    >
                      <For each={ROLE_ORDER}>
                        {(role) => (
                          // owner ロールの付与は owner のみ。admin は選べない。
                          <Show when={role !== "owner" || callerIsOwner()}>
                            <option value={role}>{ROLE_LABEL[role]}</option>
                          </Show>
                        )}
                      </For>
                    </Select>
                  </FormField>
                  <Button
                    variant="primary"
                    type="submit"
                    icon={<UserPlus size={16} />}
                    busy={invite.busy()}
                    disabled={invite.busy()}
                  >
                    招待
                  </Button>
                </form>
                <Show when={invite.error()}>
                  {(m) => <p class="wb-error" role="alert">{m()}</p>}
                </Show>
              </CardSection>
            </Card>
          </Show>

          <Show when={changeRole.error()}>
            {(m) => <p class="wb-error" role="alert">{m()}</p>}
          </Show>
          <Show when={remove.error()}>
            {(m) => <p class="wb-error" role="alert">{m()}</p>}
          </Show>

          <Switch>
            <Match when={members.error}>
              <EmptyState
                icon={<Users size={28} />}
                title="取得に失敗しました"
                message={(members.error as ControlApiError).message}
              />
            </Match>
            <Match when={!members.error}>
              <Show
                when={members.loading || (members()?.length ?? 0) > 0}
                fallback={
                  <EmptyState
                    ink
                    icon={<Users size={28} />}
                    title="まだメンバーがいません"
                    message="この Space にはまだメンバーがいません。"
                  />
                }
              >
                <DataTable
                  columns={columns()}
                  rows={members()}
                  rowKey={(member) => member.accountId}
                  loading={members.loading}
                  skeletonRows={3}
                />
              </Show>
            </Match>
          </Switch>

          {/* オーナーでない閲覧者向けの注記。 */}
          <Show when={members() && !canInvite()}>
            <p class="wb-note">
              メンバーの招待・役割変更・削除はオーナーまたは管理者のみ行えます。
            </p>
          </Show>
        </div>
      </Show>
    </AppShell>
  );
}
