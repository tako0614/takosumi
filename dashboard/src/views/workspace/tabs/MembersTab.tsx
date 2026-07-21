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
  ControlApiError,
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
import { friendlyError } from "../../../lib/error-copy.ts";
import { locale, type MessageKey, t } from "../../../i18n/index.ts";
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
  Toast,
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

// Invite options run least→most privileged: the safe default (viewer) is both
// the signal default and the FIRST option, so granting owner is always an
// explicit, deliberate pick — never what an untouched form submits.
const INVITE_ROLE_ORDER: readonly ControlWorkspaceRole[] = [
  "viewer",
  "member",
  "admin",
  "owner",
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

/** First ~10 chars of an opaque account subject, with an ellipsis marker. */
function shortSubject(accountId: string): string {
  return accountId.length > 11 ? `${accountId.slice(0, 10)}…` : accountId;
}

function rolesLabel(roles: readonly ControlWorkspaceRole[]): string {
  if (roles.length === 0) return "—";
  // "・" is the JA list interpunct; EN reads better with a comma.
  const separator = locale() === "ja" ? "・" : ", ";
  return roles.map((r) => t(ROLE_KEY[r])).join(separator);
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

  // An errored resource THROWS on read; route every data read through this
  // guarded accessor so a failed list falls through to the error EmptyState
  // below instead of crashing the tab (mirrors RunsListView / RunGroupView).
  const memberRows = (): readonly PublicWorkspaceMember[] =>
    members.error ? [] : (members.latest ?? []);

  const caller = (): PublicWorkspaceMember | undefined => {
    const subject = callerSubject();
    if (!subject) return undefined;
    return memberRows().find((m) => m.accountId === subject);
  };
  const callerRoles = (): readonly ControlWorkspaceRole[] =>
    caller()?.status === "active" ? (caller()?.roles ?? []) : [];
  const canInvite = () =>
    callerRoles().includes("owner") || callerRoles().includes("admin");
  const canManage = () => callerRoles().includes("owner");
  const callerIsOwner = () => callerRoles().includes("owner");

  const activeOwnerCount = () =>
    memberRows().filter(
      (m) => m.status === "active" && m.roles.includes("owner"),
    ).length;

  const [inviteEmail, setInviteEmail] = createSignal("");
  const [inviteRole, setInviteRole] =
    createSignal<ControlWorkspaceRole>("viewer");
  // The roster never carries an email/display name (opaque tsub_ subjects
  // only), so confirm the invite by echoing the email the operator entered.
  const [inviteSuccess, setInviteSuccess] = createSignal<string | null>(null);
  const invite = createAction(async () => {
    const email = inviteEmail().trim();
    if (!email) throw new Error(t("members.invite.emailRequired"));
    setInviteSuccess(null);
    try {
      await inviteMember(props.workspaceId, {
        email,
        role: inviteRole(),
      });
    } catch (err) {
      // The control plane answers an unknown email with an untranslated
      // English sentence, and `friendlyError` passes 4xx text through — so the
      // single most likely failure landed in a Japanese UI in English.
      if (err instanceof ControlApiError && err.status === 404) {
        throw new Error(t("members.invite.notFound"));
      }
      throw err;
    }
    setInviteSuccess(email);
    setInviteEmail("");
    setInviteRole("viewer");
    await refetch();
  });

  // Role changes are confirmed and revert the <select> on cancel/failure: the
  // native select already shows the NEW role the moment the user picks it, so
  // without an explicit reset a cancelled or failed change would keep
  // displaying a role that was never applied.
  const changeRole = createAction(
    async (
      member: PublicWorkspaceMember,
      role: ControlWorkspaceRole,
      selectEl: HTMLSelectElement,
    ) => {
      const currentRole = member.roles[0] ?? "member";
      const revert = () => {
        selectEl.value = currentRole;
      };
      const ok = await confirm({
        title: t("members.roleChangeConfirmTitle"),
        message: t("members.roleChangeConfirmMessage", {
          // Never interpolate the full opaque tsub_ subject into copy.
          name: shortSubject(member.accountId),
          role: t(ROLE_KEY[role]),
        }),
        confirmText: t("members.changeRole"),
      });
      if (!ok) {
        revert();
        return;
      }
      try {
        await setMemberRole(props.workspaceId, member.accountId, role);
      } catch (err) {
        revert();
        throw err;
      }
      await refetch();
    },
  );

  // Which member is being removed — remove is one shared action, so without
  // this every row's button would go busy during a single removal (same
  // per-row idiom as SharesTab/BackupsTab).
  const [removingSubject, setRemovingSubject] = createSignal<string | null>(
    null,
  );
  const remove = createAction(async (member: PublicWorkspaceMember) => {
    // Removing YOURSELF locks you out of this workspace with no self-service
    // way back — the generic "remove this member (tsub_ab12…)" wording made
    // that indistinguishable from removing someone else.
    const isSelf = member.accountId === callerSubject();
    const ok = await confirm({
      title: isSelf ? t("members.removeSelf") : t("members.remove"),
      message: isSelf
        ? t("members.removeSelfConfirm")
        : t("members.removeConfirm", {
            account: shortSubject(member.accountId),
          }),
      confirmText: isSelf ? t("members.removeSelf") : t("members.remove"),
      danger: true,
    });
    if (!ok) return;
    setRemovingSubject(member.accountId);
    try {
      await removeMember(props.workspaceId, member.accountId);
      await refetch();
    } finally {
      setRemovingSubject(null);
    }
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
            {/* `tsub_…` subjects are opaque machine ids — show a short prefix
                so the roster stays scannable; the full id lives in the title
                attribute for hover/copy inspection. */}
            <code class="wb-mono" title={member.accountId}>
              {shortSubject(member.accountId)}
            </code>
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
                  {/* Decorative — the accessible name comes from aria-label. */}
                  <ShieldCheck size={14} aria-hidden="true" />
                  <Select
                    aria-label={t("members.roleSelectLabel", {
                      name: shortSubject(member.accountId),
                    })}
                    disabled={changeRole.busy() || isLastOwner(member)}
                    value={member.roles[0] ?? "member"}
                    onChange={(e) =>
                      void changeRole.run(
                        member,
                        e.currentTarget.value as ControlWorkspaceRole,
                        e.currentTarget,
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
                  busy={remove.busy() && removingSubject() === member.accountId}
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
                  <For each={INVITE_ROLE_ORDER}>
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
            <Show when={inviteSuccess()}>
              {(email) => (
                <Toast tone="success">
                  {t("members.invite.success", { email: email() })}
                </Toast>
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
          {(error) => (
            <EmptyState
              icon={<Users size={28} />}
              title={t("workspaceSettings.tab.members")}
              message={friendlyError(error(), t).message}
              action={
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => void refetch()}
                >
                  {t("common.retry")}
                </Button>
              }
            />
          )}
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
              // First-load skeleton only — refetch after invite / role change /
              // remove keeps the roster rendered instead of flashing skeletons.
              loading={members.loading && !members.latest}
              skeletonRows={3}
            />
          </Show>
        </Match>
      </Switch>

      <Show when={memberRows().length > 0 && !canInvite()}>
        <p class="wb-note">{t("members.viewerNote")}</p>
      </Show>
    </div>
  );
}
