/**
 * Source-assertion regression tests for the Members 画面 (ControlMembersView).
 * Pure-source assertions (no DOM / SolidJS), in the same style as
 * `installation-deployments_test.ts`: they read the view source and lock in the
 * load-bearing access-control wiring so a future edit that drops the owner-only
 * gates, the last-owner guard, or the plain-Japanese labels fails loudly.
 *
 * The membership surface is access-control sensitive, so these assertions are
 * the UI-side backstop to the server gate in
 * packages/accounts-service/src/control-routes.ts (list = member 可; invite =
 * owner/admin; role change + remove = owner-only + last-owner guard).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./ControlMembersView.tsx", import.meta.url),
  "utf8",
);

describe("ControlMembersView access-control surface", () => {
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
    expect(source).toContain("<Show when={canManage()}>");
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

  test("the spaceId comes from shared state, never from the row/client body", () => {
    expect(source).toContain("currentSpaceId");
    // Mutations pass the resolved spaceId + the member's accountId only.
    expect(source).toMatch(/setMemberRole\(id, member\.accountId/);
    expect(source).toMatch(/removeMember\(id, member\.accountId\)/);
  });

  test("labels are plain Japanese (メンバー / 招待 / 役割)", () => {
    expect(source).toContain("メンバー");
    expect(source).toContain("招待");
    expect(source).toContain("役割");
    expect(source).toContain('owner: "オーナー"');
    expect(source).toContain('member: "メンバー"');
  });
});
