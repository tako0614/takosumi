/**
 * アカウント > メンバー: the people who use this workspace, by name.
 *
 * The roster shows each member's display name; emails come back from the
 * server only for owners and admins, so everyone else simply never sees them.
 * Role gates mirror the backend (convenience only — the server re-checks every
 * mutation from the membership ledger): list = any member; invite = owner /
 * admin; role change & remove = owner; the last active owner can be neither
 * demoted nor removed. 招待 adds an EXISTING account by its verified email
 * (no email is sent).
 */
import { createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { UserPlus, Users } from "lucide-solid";
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
import { memberLabel } from "../../../lib/account-labels.ts";
import { type MessageKey, t } from "../../../i18n/index.ts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardSection,
  EmptyState,
  FormField,
  Input,
  Select,
  Skeleton,
  Toast,
} from "../../../components/ui/index.ts";

const ROLE_KEY: Record<ControlWorkspaceRole, MessageKey> = {
  owner: "members.role.owner",
  admin: "members.role.admin",
  member: "members.role.member",
  viewer: "members.role.viewer",
};

/** What each role can do, one line each, shown above the list. */
const ROLE_HELP_KEY: Record<ControlWorkspaceRole, MessageKey> = {
  owner: "members.roleHelp.owner",
  admin: "members.roleHelp.admin",
  member: "members.roleHelp.member",
  viewer: "members.roleHelp.viewer",
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
  const label = (member: PublicWorkspaceMember) =>
    memberLabel(member, props.session);

  // An errored resource THROWS on read; every data read goes through this
  // guarded accessor so a failed list falls through to the error state.
  const memberRows = (): readonly PublicWorkspaceMember[] =>
    members.error ? [] : (members.latest ?? []);
  // Suspended rows are people who were removed; the list is about who uses
  // the workspace now.
  const visibleRows = () =>
    memberRows().filter((member) => member.status !== "suspended");

  const caller = (): PublicWorkspaceMember | undefined =>
    memberRows().find((member) => member.accountId === callerSubject());
  const callerRoles = (): readonly ControlWorkspaceRole[] =>
    caller()?.status === "active" ? (caller()?.roles ?? []) : [];
  const canInvite = () =>
    callerRoles().includes("owner") || callerRoles().includes("admin");
  const canManage = () => callerRoles().includes("owner");

  const activeOwnerCount = () =>
    memberRows().filter(
      (member) => member.status === "active" && member.roles.includes("owner"),
    ).length;
  const isLastOwner = (member: PublicWorkspaceMember) =>
    member.status === "active" &&
    member.roles.includes("owner") &&
    activeOwnerCount() <= 1;

  const [inviteOpen, setInviteOpen] = createSignal(false);
  const [inviteEmail, setInviteEmail] = createSignal("");
  const [inviteRole, setInviteRole] =
    createSignal<ControlWorkspaceRole>("viewer");
  const [inviteSuccess, setInviteSuccess] = createSignal<string | null>(null);
  const invite = createAction(async () => {
    const email = inviteEmail().trim();
    if (!email) throw new Error(t("members.invite.emailRequired"));
    setInviteSuccess(null);
    try {
      await inviteMember(props.workspaceId, { email, role: inviteRole() });
    } catch (err) {
      // The control plane answers an unknown email with an English sentence;
      // the likeliest failure gets the next step in the user's language.
      if (err instanceof ControlApiError && err.status === 404) {
        throw new Error(t("members.invite.notFound"));
      }
      throw err;
    }
    setInviteSuccess(email);
    setInviteEmail("");
    setInviteRole("viewer");
    setInviteOpen(false);
    await refetch();
  });

  // Role changes are confirmed and revert the <select> on cancel/failure: the
  // native select already shows the NEW role the moment the user picks it.
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
        message: `${t("members.roleChangeConfirmMessage", {
          name: label(member),
          role: t(ROLE_KEY[role]),
        })} ${t(ROLE_HELP_KEY[role])}`,
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

  // Per-row busy: remove is one shared action.
  const [removingSubject, setRemovingSubject] = createSignal<string | null>(
    null,
  );
  const remove = createAction(async (member: PublicWorkspaceMember) => {
    const isSelf = member.accountId === callerSubject();
    const ok = await confirm({
      title: isSelf ? t("members.removeSelf") : t("members.removeTitle", { name: label(member) }),
      message: isSelf
        ? t("members.removeSelfConfirm")
        : t("members.removeConfirm", { name: label(member) }),
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

  const memberCard = (member: PublicWorkspaceMember) => (
    <li class="acct-row tg-card">
      <div class="acct-row-main">
        <div class="acct-row-title">
          <strong class="acct-person-name">{label(member)}</strong>
          <Show when={member.accountId === callerSubject()}>
            <Badge tone="info">{t("members.you")}</Badge>
          </Show>
          <Show when={member.status !== "active"}>
            <Badge tone={statusTone(member.status)}>
              {t(STATUS_KEY[member.status])}
            </Badge>
          </Show>
        </div>
        <div class="acct-row-meta">
          {/* Only owners and admins receive emails from the server. */}
          <Show when={member.email}>
            {(email) => <span class="acct-person-email">{email()}</span>}
          </Show>
          <Show when={!canManage() || member.status !== "active"}>
            <span>{member.roles.map((role) => t(ROLE_KEY[role])).join(" · ")}</span>
          </Show>
        </div>
      </div>
      <Show when={canManage() && member.status === "active"}>
        <div class="acct-row-actions">
          <Select
            aria-label={t("members.roleSelectLabel", { name: label(member) })}
            disabled={changeRole.busy() || isLastOwner(member)}
            value={member.roles[0] ?? "member"}
            onChange={(event) =>
              void changeRole.run(
                member,
                event.currentTarget.value as ControlWorkspaceRole,
                event.currentTarget,
              )
            }
            title={
              isLastOwner(member)
                ? t("members.lastOwnerDemote")
                : t("members.changeRole")
            }
          >
            {/* `selected` on the option: the select's value is assigned
                before its options render, which left every row on the
                first option. */}
            <For each={ROLE_ORDER}>
              {(role) => (
                <option
                  value={role}
                  selected={role === (member.roles[0] ?? "member")}
                >
                  {t(ROLE_KEY[role])}
                </option>
              )}
            </For>
          </Select>
          <Button
            variant="ghost"
            size="sm"
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
    </li>
  );

  return (
    <div class="acct-stack">
      <Card>
        <CardHeader
          title={t("members.title")}
          subtitle={t("members.subtitle")}
          actions={
            <Show when={canInvite() && !inviteOpen()}>
              <Button
                variant="primary"
                size="sm"
                icon={<UserPlus size={15} />}
                onClick={() => {
                  setInviteOpen(true);
                  setInviteSuccess(null);
                }}
              >
                {t("members.invite.open")}
              </Button>
            </Show>
          }
        />
        <CardSection>
          <dl class="acct-roles">
            <For each={ROLE_ORDER}>
              {(role) => (
                <div class="acct-role">
                  <dt>{t(ROLE_KEY[role])}</dt>
                  <dd>{t(ROLE_HELP_KEY[role])}</dd>
                </div>
              )}
            </For>
          </dl>
        </CardSection>
        <Show when={inviteOpen()}>
          <CardSection>
            <form
              class="acct-invite-form"
              onSubmit={(event) => {
                event.preventDefault();
                void invite.run();
              }}
            >
              <p class="acct-help">{t("members.invite.subtitle")}</p>
              <FormField label={t("members.invite.email")}>
                <Input
                  type="email"
                  value={inviteEmail()}
                  onInput={(event) => setInviteEmail(event.currentTarget.value)}
                  placeholder="name@example.com"
                  autocomplete="email"
                  spellcheck={false}
                />
              </FormField>
              <FormField label={t("members.invite.role")}>
                <Select
                  value={inviteRole()}
                  onChange={(event) =>
                    setInviteRole(
                      event.currentTarget.value as ControlWorkspaceRole,
                    )
                  }
                >
                  <For each={INVITE_ROLE_ORDER}>
                    {(role) => (
                      // Only an owner may grant the owner role.
                      <Show when={role !== "owner" || canManage()}>
                        <option value={role}>{t(ROLE_KEY[role])}</option>
                      </Show>
                    )}
                  </For>
                </Select>
              </FormField>
              <div class="wc-form-actions">
                <Button
                  variant="primary"
                  type="submit"
                  icon={<UserPlus size={16} />}
                  busy={invite.busy()}
                >
                  {t("members.invite.cta")}
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    setInviteOpen(false);
                    invite.clearError();
                  }}
                >
                  {t("common.cancel")}
                </Button>
              </div>
              <Show when={invite.error()}>
                {(message) => (
                  <p class="wb-error" role="alert">
                    {message()}
                  </p>
                )}
              </Show>
            </form>
          </CardSection>
        </Show>
        <Show when={inviteSuccess()}>
          {(email) => (
            <CardSection>
              <Toast tone="success">
                {t("members.invite.success", { email: email() })}
              </Toast>
            </CardSection>
          )}
        </Show>
      </Card>

      <Show when={changeRole.error()}>
        {(message) => (
          <p class="wb-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={remove.error()}>
        {(message) => (
          <p class="wb-error" role="alert">
            {message()}
          </p>
        )}
      </Show>

      <Switch>
        <Match when={members.error}>
          {(error) => (
            <EmptyState
              icon={<Users size={28} />}
              title={t("members.loadFailedTitle")}
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
        <Match when={members.loading && !members.latest}>
          <Skeleton variant="card" count={2} />
        </Match>
        <Match when={visibleRows().length > 0}>
          <ul class="acct-list" aria-label={t("members.listLabel")}>
            <For each={visibleRows()}>{(member) => memberCard(member)}</For>
          </ul>
        </Match>
        <Match when>
          <p class="muted">{t("members.empty")}</p>
        </Match>
      </Switch>

      <Show when={memberRows().length > 0 && !canInvite()}>
        <p class="acct-footnote">{t("members.viewerNote")}</p>
      </Show>
    </div>
  );
}
