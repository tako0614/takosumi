import { TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH } from "@takosjp/takosumi-accounts-contract";

export function matchAccountTokenRevokeRoute(
  pathname: string,
): { tokenId: string } | null {
  const prefix = `${TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const parts = pathname.slice(prefix.length).split("/");
  if (parts.length !== 2 || parts[1] !== "revoke" || !parts[0]) return null;
  return { tokenId: parts[0] };
}
