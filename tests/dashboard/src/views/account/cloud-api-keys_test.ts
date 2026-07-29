import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TAKOSUMI_ACCOUNTS_PAT_SCOPES,
  TAKOSUMI_ACCOUNTS_SELF_SERVICE_PAT_SCOPES,
} from "@takosjp/takosumi-accounts-contract";
import { buildSelfServiceCloudApiKeyRequest } from "../../../../../dashboard/src/views/account/lib/tokens.ts";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

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
    expect(TAKOSUMI_ACCOUNTS_PAT_SCOPES).toEqual([
      "read",
      "write",
      "admin",
    ]);
    expect(TAKOSUMI_ACCOUNTS_SELF_SERVICE_PAT_SCOPES).toEqual([
      "read",
      "write",
    ]);
    expect(component).toContain(
      "TAKOSUMI_ACCOUNTS_SELF_SERVICE_PAT_SCOPES",
    );
    expect(component).not.toContain('["read", "write", "admin"]');
    expect(component).toContain('case "admin":');
    expect(component).toContain("expires_at:");
    expect(component).toContain("workspace_id: props.workspaceId");
    expect(component).toContain('createSignal(true)');
  });

  test("never sends operator-issued admin scope through self-service", () => {
    const request = buildSelfServiceCloudApiKeyRequest({
      name: "Development CLI",
      scopes: ["read", "admin", "write"],
    });

    expect(request.scopes).toEqual(["read", "write"]);
    expect(request.scopes).not.toContain("admin");
  });

  test("explains why administrative access is unavailable", () => {
    expect(component).toContain('hint={t("account.apiKeys.scopesHint")}');
    expect(en["account.apiKeys.scopesHint"]).toContain(
      "cannot be created here",
    );
    expect(ja["account.apiKeys.scopesHint"]).toContain(
      "この画面からは作成できません",
    );
  });
});
