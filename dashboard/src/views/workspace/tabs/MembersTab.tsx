/**
 * Workspace settings — メンバー. Port of the former ControlMembersView body.
 *
 * Role gates mirror the backend (convenience only — the server re-checks every
 * mutation from the membership ledger): list = any member; invite = owner /
 * admin; role change & remove = owner; the last active owner can be neither
 * demoted nor removed. 招待 adds an EXISTING account handle / subject directly
 * (no email invites).
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
import { ShieldCheck, Trash2, UserPlus, Users } from "lucide-solid";
import {
  type ControlApiError,
  type ControlWorkspaceRole,
  inviteMember,
  listMembers,
  type PublicWorkspaceMember,
  removeMember,
  setMemberRole,
} from "../../../lib/control-api.ts";
import type { SessionRecord } from "../../account/lib/session.ts";
import { createAction } from "../../account/lib/action.tsx";
import { useConfirmDialog } from "../../../lib/confirm-dialog.ts";
import { type MessageKey, t } from "../../../i18n/index.ts";
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
  Select,
} from "../../../components/ui/index.ts";

const ROLE_KEY: Record<ControlWorkspaceRole, MessageKey> = {
  owner: "members.role.owner",
  admin: "members.role.admin",
  member: "members.role.member",
  viewer: "members.role.viewer",
};

const ROLE_ORDER: readonly ControlWorkspaceRole[] = [
  "owner",
  "admin",
  "member",
  "viewer",
];

const STATUS_KEY: Record<PublicWorkspaceMember["status"], MessageKey> = {
  active: "members.status.active",
  invited: "members.status.invited",
  suspended: "members.status.suspended",
};

function statusTone(
  status: PublicWorkspaceMember["status"],
): "ok" | "info" | "muted" {
  if (status === "active") return "ok";
  if (status === "invited") return "info";
  return "muted";
}

function rolesLabel(roles: readonly ControlWorkspaceRole[]): string {
  if (roles.length === 0) return "—";
  return roles.map((r) => t(ROLE_KEY[r])).join("・");
}

export default function MembersTab(props: {
  readonly workspaceId: string;
  readonly session: SessionRecord;
}) {
  const { confirm } = useConfirmDialog();
  const [members, { refetch }] = createResource(
    () => props.workspaceId,
    listMembers,
  );
  const callerSubject = () => props.session.subject;

  const caller = (): PublicWorkspaceMember | undefined => {
    const subject = callerSubject();
    if (!subject) return undefined;
    return (members() ?? []).find((m) => m.accountId === subject);
  };
  const callerRoles = (): readonly ControlWorkspaceRole[] =>
    caller()?.status === "active" ? (caller()?.roles ?? []) : [];
  const canInvite = () =>
    callerRoles().includes("owner") || callerRoles().includes("admin");
  const canManage = () => callerRoles().includes("owner");
  const callerIsOwner = () => callerRoles().includes("owner");

  const activeOwnerCount = () =>
    (members() ?? []).filter(
      (m) => m.status === "active" && m.roles.includes("owner"),
    ).length;

  const [inviteEmail, setInviteEmail] = createSignal("");
  const [inviteRole, setInviteRole] = createSignal<ControlWorkspaceRole>("member");
  const invite = createAction(async () => {
    const email = inviteEmail().trim();
    if (!email) throw new Error(t("members.invite.emailRequired"));
    await inviteMember(props.workspaceId, {
      email,
      role: inviteRole(),
    });
    setInviteEmail("");
    setInviteRole("member");
    await refetch();
  });

  const changeRole = createAction(
    async (member: PublicWorkspaceMember, role: ControlWorkspaceRole) => {
      await setMemberRole(props.workspaceId, member.accountId, role);
      await refetch();
    },
  );

  const remove = createAction(async (member: PublicWorkspaceMember) => {
    const ok = await confirm({
      title: t("members.remove"),
      message: t("members.removeConfirm", { account: member.accountId }),
      confirmText: t("members.remove"),
      danger: true,
    });
    if (!ok) return;
    await removeMember(props.workspaceId, member.accountId);
    await refetch();
  });

  const isLastOwner = (member: PublicWorkspaceMember) =>
    member.status === "active" &&
    member.roles.includes("owner") &&
    activeOwnerCount() <= 1;

  const columns = createMemo<readonly Column<PublicWorkspaceMember>[]>(() => {
    const base: Column<PublicWorkspaceMember>[] = [
      {
        header: t("members.col.member"),
        cell: (member) => (
          <>
            <code class="wb-mono">{member.accountId}</code>
            <Show when={member.accountId === callerSubject()}>
              <Badge tone="info" class="wb-you-tag">
                {t("members.you")}
              </Badge>
            </Show>
          </>
        ),
      },
      {
        header: t("members.col.roles"),
        cell: (member) => rolesLabel(member.roles),
      },
      {
        header: t("members.col.status"),
        cell: (member) => (
          <Badge tone={statusTone(member.status)}>
            {t(STATUS_KEY[member.status])}
          </Badge>
        ),
      },
    ];
    if (canManage()) {
      base.push({
        header: t("members.col.actions"),
        align: "right",
        // Inner gate mirrors the column-level one — fail-closed backstop in an
        // access-control-sensitive surface.
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
                        e.currentTarget.value as ControlWorkspaceRole,
                      )
                    }
                    title={
                      isLastOwner(member)
                        ? t("members.lastOwnerDemote")
                        : t("members.changeRole")
                    }
                  >
                    <For each={ROLE_ORDER}>
                      {(role) => (
                        <option value={role}>{t(ROLE_KEY[role])}</option>
                      )}
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
                      ? t("members.lastOwnerRemove")
                      : t("members.remove")
                  }
                  onClick={() => void remove.run(member)}
                >
                  {t("members.remove")}
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
    <div class="wb-stack">
      <Show when={canInvite()}>
        <Card>
          <CardHeader
            title={t("members.invite.title")}
            subtitle={t("members.invite.subtitle")}
          />
          <CardSection>
            <form
              class="wb-invite-form"
              onSubmit={(e) => {
                e.preventDefault();
                void invite.run();
              }}
            >
              <FormField label={t("members.invite.email")}>
                <Input
                  type="email"
                  value={inviteEmail()}
                  onInput={(e) => setInviteEmail(e.currentTarget.value)}
                  placeholder="name@example.com"
                  autocomplete="email"
                  spellcheck={false}
                />
              </FormField>
              <FormField label={t("members.invite.role")}>
                <Select
                  value={inviteRole()}
                  onChange={(e) =>
                    setInviteRole(e.currentTarget.value as ControlWorkspaceRole)
                  }
                >
                  <For each={ROLE_ORDER}>
                    {(role) => (
                      // owner ロールの付与は owner のみ。admin は選べない。
                      <Show when={role !== "owner" || callerIsOwner()}>
                        <option value={role}>{t(ROLE_KEY[role])}</option>
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
                {t("members.invite.cta")}
              </Button>
            </form>
            <Show when={invite.error()}>
              {(m) => (
                <p class="wb-error" role="alert">
                  {m()}
                </p>
              )}
            </Show>
          </CardSection>
        </Card>
      </Show>

      <Show when={changeRole.error()}>
        {(m) => (
          <p class="wb-error" role="alert">
            {m()}
          </p>
        )}
      </Show>
      <Show when={remove.error()}>
        {(m) => (
          <p class="wb-error" role="alert">
            {m()}
          </p>
        )}
      </Show>

      <Switch>
        <Match when={members.error}>
          <EmptyState
            icon={<Users size={28} />}
            title={t("workspaceSettings.tab.members")}
            message={t("common.fetchFailed", {
              message: (members.error as ControlApiError).message,
            })}
          />
        </Match>
        <Match when={!members.error}>
          <Show
            when={members.loading || (members()?.length ?? 0) > 0}
            fallback={
              <EmptyState
                icon={<Users size={28} />}
                title={t("workspaceSettings.tab.members")}
                message={t("members.empty")}
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

      <Show when={members() && !canInvite()}>
        <p class="wb-note">{t("members.viewerNote")}</p>
      </Show>
    </div>
  );
}
