/**
 * Source-assertion regression tests for the Members tab (MembersTab).
 * Pure-source assertions (no DOM / SolidJS): they read the view source and
 * lock in the load-bearing access-control wiring so a future edit that drops
 * the owner-only gates or the last-owner guard fails loudly.
 *
 * The membership surface is access-control sensitive, so these assertions are
 * the UI-side backstop to the server gate in
 * accounts/service/src/control-routes.ts (list = member 可; invite =
 * owner/admin; role change + remove = owner-only + last-owner guard).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../../../../dashboard/src/views/workspace/tabs/MembersTab.tsx",
    import.meta.url,
  ),
  "utf8",
);

describe("MembersTab access-control surface", () => {
  test("uses the four membership client fns (no ad-hoc fetch)", () => {
    expect(source).toContain("listMembers");
    expect(source).toContain("inviteMember");
    expect(source).toContain("setMemberRole");
    expect(source).toContain("removeMember");
    // The view must NOT hand-roll a fetch — it goes through control-api.ts.
    expect(source).not.toMatch(/\bfetch\(/);
  });

  test("derives the caller's roles from the roster matched by account subject", () => {
    // The server matches a member by `accountId === subject`; the UI gate must
    // do the same so it never shows a control the server would reject.
    expect(source).toContain("props.session.subject");
    expect(source).toMatch(/m\.accountId === /);
  });

  test("invite is gated to owner/admin; role-change + remove to owner only", () => {
    expect(source).toMatch(/canInvite = \(\) =>[\s\S]*?"owner"[\s\S]*?"admin"/);
    expect(source).toMatch(/canManage = \(\) =>[\s\S]*?"owner"/);
    // The 操作 column (役割変更・削除) is owner-only.
    expect(source).toContain("<Show when={canManage()}");
  });

  test("only an owner may offer the owner role in the invite form", () => {
    expect(source).toContain("callerIsOwner");
    expect(source).toMatch(/role !== "owner" \|\| callerIsOwner\(\)/);
  });

  test("the last-owner guard disables demote + remove for the sole owner", () => {
    expect(source).toContain("isLastOwner");
    expect(source).toContain("activeOwnerCount");
    // Both the role <select> and the 削除 button are disabled for the last owner.
    expect(source).toMatch(/disabled=\{[^}]*isLastOwner\(member\)/g);
  });

  test("the spaceId comes from the settings container, never from a body", () => {
    // The tab receives the globally-selected Space via props; mutations pass it
    // as the path segment plus the member's accountId only.
    expect(source).toMatch(
      /setMemberRole\(props\.workspaceId, member\.accountId/,
    );
    expect(source).toMatch(
      /removeMember\(props\.workspaceId, member\.accountId\)/,
    );
  });

  test("invites by verified email, not by handle/account subject", () => {
    expect(source).toContain("const [inviteEmail");
    expect(source).toContain("email,");
    expect(source).toContain('type="email"');
    expect(source).toContain('autocomplete="email"');
    expect(source).toContain('t("members.invite.email")');
    expect(source).not.toContain("Email invites are not supported");
    expect(source).not.toContain("inviteAccount");
  });

  test("role changes are confirmed and the select reverts on cancel/failure", () => {
    // A native <select> shows the NEW role the instant the user picks it, so
    // both the cancel path and the server-failure path must reset it to the
    // source-of-truth role or the UI displays a role that was never applied.
    expect(source).toContain('t("members.roleChangeConfirmTitle")');
    expect(source).toContain('t("members.roleChangeConfirmMessage"');
    expect(source).toContain("selectEl: HTMLSelectElement");
    expect(source).toContain("selectEl.value = currentRole;");
    // Cancel reverts…
    expect(source).toMatch(/if \(!ok\) \{\s*revert\(\);\s*return;\s*\}/);
    // …and a failed setMemberRole reverts before surfacing the error.
    expect(source).toMatch(/catch \(err\) \{\s*revert\(\);\s*throw err;\s*\}/);
    // The onChange handler passes the select element for the rollback.
    expect(source).toContain("e.currentTarget,");
  });

  test("labels go through the locale dictionary (no hardcoded copy)", () => {
    expect(source).toContain('"members.role.owner"');
    expect(source).toContain('"members.role.member"');
    expect(source).toContain('t("members.invite.cta")');
    expect(source).toContain("t(ROLE_KEY[");
  });

  test("invite defaults to the least-privileged role, ordered least→most", () => {
    // The safe default is BOTH the signal value and the first DOM option, so
    // even a select whose value assignment races option rendering falls back
    // to viewer — never owner.
    expect(source).toContain('createSignal<ControlWorkspaceRole>("viewer")');
    expect(source).toContain('setInviteRole("viewer");');
    expect(source).toMatch(
      /INVITE_ROLE_ORDER: readonly ControlWorkspaceRole\[\] = \[\s*"viewer",\s*"member",\s*"admin",\s*"owner",\s*\]/,
    );
    expect(source).toContain("<For each={INVITE_ROLE_ORDER}>");
    expect(source).not.toContain('createSignal<ControlWorkspaceRole>("owner")');
  });

  test("member cell truncates raw subjects, keeping the full id on title", () => {
    expect(source).toContain("function shortSubject(accountId: string)");
    expect(source).toContain("{shortSubject(member.accountId)}");
    expect(source).toContain("title={member.accountId}");
    expect(source).not.toContain(
      '<code class="wb-mono">{member.accountId}</code>',
    );
  });

  test("remove is busy per member row, not for the whole roster", () => {
    expect(source).toContain("const [removingSubject, setRemovingSubject]");
    expect(source).toContain("setRemovingSubject(member.accountId);");
    expect(source).toMatch(/finally \{\s*setRemovingSubject\(null\);\s*\}/);
    expect(source).toContain(
      "remove.busy() && removingSubject() === member.accountId",
    );
  });
});
