/**
 * Human labels for the people behind opaque account subjects.
 *
 * The member list carries each member's display name (and, for owners and
 * admins only, their email). Activity records carry only account subjects.
 * The signed-in person's own name is known from the session, so their rows
 * read as them. Anyone without a name reads as "メンバー" plus a short,
 * stable subject prefix that matches between the member list and history.
 */
import { t } from "../i18n/index.ts";

export interface SessionIdentity {
  readonly subject: string;
  readonly primaryAccountId?: string;
  readonly displayName?: string;
  readonly email?: string;
}

/** First ~10 chars of an opaque account subject, with an ellipsis marker. */
export function shortSubject(accountId: string): string {
  return accountId.length > 11 ? `${accountId.slice(0, 10)}…` : accountId;
}

export function isSessionAccount(
  accountId: string,
  session: SessionIdentity | undefined,
): boolean {
  return Boolean(
    session &&
      (accountId === session.subject ||
        (session.primaryAccountId !== undefined &&
          accountId === session.primaryAccountId)),
  );
}

/** The signed-in person's own name: display name, else email. */
export function sessionDisplayName(
  session: SessionIdentity | undefined,
): string | undefined {
  return session?.displayName?.trim() || session?.email?.trim() || undefined;
}

/** Who performed an Activity event, for history rows. */
export function activityActorLabel(
  actorId: string,
  session: SessionIdentity | undefined,
): string {
  if (isSessionAccount(actorId, session)) return t("activity.actorYou");
  // Runs started without a user (scheduled auto-update and similar) record
  // the control plane itself as the actor.
  if (actorId === "system") return t("activity.actorSystem");
  return shortSubject(actorId);
}

/** A roster member's label: you, their display name, or "メンバー" + short id. */
export function memberLabel(
  member: { readonly accountId: string; readonly displayName?: string },
  session: SessionIdentity | undefined,
): string {
  if (isSessionAccount(member.accountId, session)) {
    const own = sessionDisplayName(session);
    if (own) return own;
  }
  return (
    member.displayName?.trim() ||
    t("members.unnamed", { id: shortSubject(member.accountId) })
  );
}
