import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_KIND,
  TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_PATH,
  TAKOSUMI_ACCOUNTS_PAT_SCOPES,
  TAKOSUMI_ACCOUNTS_SELF_SERVICE_PAT_SCOPES,
} from "@takosjp/takosumi-accounts-contract";
import {
  buildSelfServiceTakosumiApiKeyRequest,
  normalizeTakosumiApiKeyScopeCatalog,
} from "../../../../../dashboard/src/views/account/lib/tokens.ts";
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

const component = read("components/TakosumiApiKeysCard.tsx");
const client = read("lib/tokens.ts");

const CATALOG = {
  kind: TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_KIND,
  scopes: [
    {
      scope: "read",
      label: { ja: "読み取り", en: "Read" },
      description: {
        ja: "アカウント情報を読み取ります。",
        en: "Read account information.",
      },
      selfService: true,
      workspaceBinding: "optional",
    },
    {
      scope: "write",
      label: { ja: "変更", en: "Write" },
      description: {
        ja: "アカウント情報を変更します。",
        en: "Change account information.",
      },
      selfService: true,
      workspaceBinding: "optional",
    },
    {
      scope: "admin",
      label: { ja: "管理", en: "Admin" },
      description: {
        ja: "運用者向けの管理権限です。",
        en: "Operator-issued administrative access.",
      },
      selfService: false,
      workspaceBinding: "optional",
    },
    {
      scope: "resources:read",
      label: { ja: "リソースの読み取り", en: "Read resources" },
      description: {
        ja: "選択したワークスペースのリソースを読み取ります。",
        en: "Read resources in the selected workspace.",
      },
      selfService: true,
      workspaceBinding: "required",
    },
  ],
} as const;

describe("Takosumi API key management", () => {
  test("uses the canonical Accounts PAT contract and supports revoke", () => {
    expect(client).toContain("TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH");
    expect(client).toContain("TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_PATH");
    expect(client).toContain("takosumiAccountsAccountTokenRevokePath");
    expect(client).toContain('method: "POST"');
    // Keep this negative assertion: the view must consume the canonical
    // Accounts contract instead of reintroducing a retired literal.
    expect(client).not.toContain('"/v1/account/tokens"');
    expect(TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_PATH).toBe(
      "/api/v1/account/tokens/scopes",
    );
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
      "resources:read",
      "ai.models.read",
      "ai.chat",
      "ai.embeddings",
    ]);
    expect(TAKOSUMI_ACCOUNTS_SELF_SERVICE_PAT_SCOPES).toEqual([
      "read",
      "write",
    ]);
    expect(component).toContain("listTakosumiApiKeyScopeCatalog");
    expect(component).toContain("selfService");
    expect(component).toContain('workspaceBinding === "required"');
    expect(component).not.toContain(
      "TAKOSUMI_ACCOUNTS_SELF_SERVICE_PAT_SCOPES",
    );
    expect(component).not.toContain('"resources:read"');
    expect(component).toContain("expires_at:");
    expect(component).toContain("workspace_id: props.workspaceId");
  });

  test("never sends operator-issued admin scope through self-service", () => {
    expect(() =>
      buildSelfServiceTakosumiApiKeyRequest(
        {
          name: "Development CLI",
          scopes: ["read", "admin", "write"],
        },
        CATALOG.scopes,
      ),
    ).toThrow("not available for self-service");
  });

  test("accepts only catalog-advertised self-service scopes", () => {
    expect(
      buildSelfServiceTakosumiApiKeyRequest(
        {
          name: "Development CLI",
          scopes: ["read", "write"],
        },
        CATALOG.scopes,
      ),
    ).toEqual({
      name: "Development CLI",
      scopes: ["read", "write"],
    });
  });

  test("requires a workspace for every required-binding scope", () => {
    expect(() =>
      buildSelfServiceTakosumiApiKeyRequest(
        { name: "Inventory", scopes: ["resources:read"] },
        CATALOG.scopes,
      ),
    ).toThrow("requires a workspace binding");

    expect(
      buildSelfServiceTakosumiApiKeyRequest(
        {
          name: "Inventory",
          scopes: ["resources:read"],
          workspace_id: "ws_inventory",
        },
        CATALOG.scopes,
      ),
    ).toEqual({
      name: "Inventory",
      scopes: ["resources:read"],
      workspace_id: "ws_inventory",
    });
  });

  test("rejects empty and duplicate create scopes", () => {
    expect(() =>
      buildSelfServiceTakosumiApiKeyRequest(
        { name: "Empty", scopes: [] },
        CATALOG.scopes,
      ),
    ).toThrow("at least one scope");
    expect(() =>
      buildSelfServiceTakosumiApiKeyRequest(
        { name: "Duplicate", scopes: ["read", "read"] },
        CATALOG.scopes,
      ),
    ).toThrow("duplicate scope");
  });

  test("rejects malformed or unversioned scope catalogs", () => {
    expect(normalizeTakosumiApiKeyScopeCatalog(CATALOG)).toEqual(CATALOG);
    expect(() =>
      normalizeTakosumiApiKeyScopeCatalog({
        kind: "takosumi.account-pat-scope-catalog@old",
        scopes: CATALOG.scopes,
      }),
    ).toThrow("scope catalog");
    expect(() =>
      normalizeTakosumiApiKeyScopeCatalog({
        kind: TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_KIND,
        scopes: ["read"],
      }),
    ).toThrow("scope catalog");
  });

  test("rejects catalog key drift and widened built-in authority", () => {
    expect(() =>
      normalizeTakosumiApiKeyScopeCatalog({ ...CATALOG, extra: true }),
    ).toThrow("scope catalog");
    expect(() =>
      normalizeTakosumiApiKeyScopeCatalog({
        ...CATALOG,
        scopes: [
          { ...CATALOG.scopes[0], extra: true },
          ...CATALOG.scopes.slice(1),
        ],
      }),
    ).toThrow("scope catalog");
    expect(() =>
      normalizeTakosumiApiKeyScopeCatalog({
        ...CATALOG,
        scopes: [
          {
            ...CATALOG.scopes[0],
            label: { ...CATALOG.scopes[0].label, extra: "unsafe" },
          },
          ...CATALOG.scopes.slice(1),
        ],
      }),
    ).toThrow("scope catalog");
    expect(() =>
      normalizeTakosumiApiKeyScopeCatalog({
        ...CATALOG,
        scopes: CATALOG.scopes.map((entry) =>
          entry.scope === "admin" ? { ...entry, selfService: true } : entry,
        ),
      }),
    ).toThrow("scope catalog");
    expect(() =>
      normalizeTakosumiApiKeyScopeCatalog({
        ...CATALOG,
        scopes: CATALOG.scopes.map((entry) =>
          entry.scope === "resources:read"
            ? { ...entry, workspaceBinding: "optional" }
            : entry,
        ),
      }),
    ).toThrow("scope catalog");
    expect(() =>
      normalizeTakosumiApiKeyScopeCatalog({
        ...CATALOG,
        scopes: CATALOG.scopes.map((entry) =>
          entry.scope === "read"
            ? { ...entry, workspaceBinding: "required" }
            : entry,
        ),
      }),
    ).toThrow("scope catalog");
  });

  test("fails closed with a visible catalog retry", () => {
    expect(component).toContain("scopeCatalog.error");
    expect(component).toContain("refetchScopeCatalog");
    expect(component).toContain('t("account.apiKeys.scopeCatalog.retry")');
    expect(component).toContain('t("account.apiKeys.scopeCatalog.loadFailed")');
  });

  test("uses server-provided localized scope labels and descriptions", () => {
    expect(component).toContain("scope.label[locale()]");
    expect(component).toContain("scope.description[locale()]");
    expect(en["account.apiKeys.scopeCatalog.workspaceRequired"]).toContain(
      "workspace",
    );
    expect(ja["account.apiKeys.scopeCatalog.workspaceRequired"]).toContain(
      "ワークスペース",
    );
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
