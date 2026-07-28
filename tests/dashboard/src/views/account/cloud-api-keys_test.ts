import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (relativePath: string) =>
  readFileSync(
    resolve(
      import.meta.dir,
      "../../../../../dashboard/src/views/account",
      relativePath,
    ),
    "utf8",
  );

const component = read("components/CloudApiKeysCard.tsx");
const client = read("lib/tokens.ts");

describe("Cloud API key management", () => {
  test("uses the canonical Accounts PAT contract and supports revoke", () => {
    expect(client).toContain("TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH");
    expect(client).toContain("takosumiAccountsAccountTokenRevokePath");
    expect(client).toContain('method: "POST"');
    expect(client).not.toContain('"/v1/account/tokens"');
  });

  test("shows a new secret once and keeps list rows metadata-only", () => {
    expect(component).toContain("created()?.token");
    expect(component).toContain('t("account.apiKeys.createdHint")');
    expect(component).toContain("TakosumiAccountsPatMetadata");
    expect(component).toContain("key.prefix");
    expect(component).not.toContain("key.token");
  });

  test("supports least-privilege scope, expiry, and Workspace binding", () => {
    expect(component).toContain('["read", "write", "admin"]');
    expect(component).toContain("expires_at:");
    expect(component).toContain("workspace_id: props.workspaceId");
    expect(component).toContain('createSignal(true)');
  });
});
