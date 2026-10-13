/** Current Accounts grant check for a previously scheduled Capsule uninstall. */
import type { CapsuleUninstallRequester } from "takosumi-contract/capsules";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { AccountsStore } from "./store.ts";
import {
  oauthAccessTokenHasScope,
  personalAccessTokenHasScope,
} from "./account-session.ts";
import { personalAccessTokenIsActive } from "./pat-routes.ts";

/**
 * The canonical Workspace role is checked separately in Core. This port only
 * verifies the Accounts subject and the exact credential grant that scheduled
 * the request. A missing lookup capability, missing row, or storage error
 * cannot turn an expired or revoked grant back on.
 */
export async function validateUninstallRequester(
  store: AccountsStore,
  requester: CapsuleUninstallRequester,
  workspaceId: string,
  now = Date.now(),
): Promise<boolean> {
  if (
    typeof requester?.subject !== "string" ||
    !requester.subject.startsWith("tsub_") ||
    typeof workspaceId !== "string" || workspaceId.length === 0 ||
    !Number.isFinite(now)
  ) return false;
  const subject = requester.subject as TakosumiSubject;
  try {
    if (!await store.findAccount(subject)) return false;
    const grant = requester.grant;
    if (grant === undefined) return true;
    if (grant.kind === "personal-access-token") {
      if (
        !grant.tokenId || !store.findPersonalAccessTokenById
      ) return false;
      const record = await store.findPersonalAccessTokenById(
        subject,
        grant.tokenId,
      );
      return record?.subject === subject &&
        record.tokenId === grant.tokenId &&
        personalAccessTokenIsActive(record, now) &&
        personalAccessTokenHasScope(record.scopes, "write") &&
        (!record.workspaceId || record.workspaceId === workspaceId);
    }
    if (grant.kind === "oauth-access-token") {
      if (
        !/^sha256:[A-Za-z0-9_-]{43}$/u.test(grant.tokenHash) ||
        !store.findAccessTokenByHash
      ) return false;
      const record = await store.findAccessTokenByHash(grant.tokenHash);
      return record?.takosumiSubject === subject &&
        record.expiresAt > now &&
        record.role !== "runtime" &&
        record.role !== "interface-runtime" &&
        oauthAccessTokenHasScope(record.scope, "write") &&
        (!record.workspaceId || record.workspaceId === workspaceId);
    }
    return false;
  } catch {
    return false;
  }
}
