import { describe, expect, test } from "bun:test";
import {
  compatibilityCheckLooksTransient,
  compatibilityDiagnosticDisplay,
  providerNameFromDiagnostic,
  isSafePlainEnvName,
  storeDefaultInputValue,
  storeEntryFromStoreListing,
  storeMetadataFromStoreListing,
  storeInstallConfigsForSource,
  storeSourceMatchesListing,
} from "../../../../../dashboard/src/views/new/install-helpers.ts";
import type { TcsListing } from "../../../../../dashboard/src/lib/tcs-client.ts";
import type { InstallConfig } from "../../../../../dashboard/src/lib/control-api.ts";

describe("compatibility diagnostics", () => {
  test("uses code and structured context instead of parsing display text", () => {
    const diagnostic = {
      code: "provider_credentials_in_source",
      severity: "warning" as const,
      message: "This message may be localized or rewritten.",
      context: { provider: "example/provider" },
    };

    expect(providerNameFromDiagnostic(diagnostic)).toBe("example/provider");
    expect(compatibilityDiagnosticDisplay(diagnostic).technical).not.toBe(true);
  });

  test("retries only the typed compatibility failure code", () => {
    const base = {
      reportId: "report_1",
      sourceSnapshotId: "snapshot_1",
      level: "unsupported" as const,
      summary: "arbitrary display text",
      providers: [],
      resources: [],
      rootModuleVariables: [],
      source: "api" as const,
    };
    expect(
      compatibilityCheckLooksTransient({
        ...base,
        diagnostics: [
          {
            code: "capsule_compatibility_check_failed",
            severity: "error",
            message: "localized text",
          },
        ],
      }),
    ).toBe(true);
    expect(
      compatibilityCheckLooksTransient({
        ...base,
        summary: "retry after source sync",
        diagnostics: [{ severity: "error", message: "operation was aborted" }],
      }),
    ).toBe(false);
  });
});

describe("plain environment variable names", () => {
  test("treats names as opaque after validating their syntax", () => {
    expect(isSafePlainEnvName("SERVICE_TOKEN")).toBe(true);
    expect(isSafePlainEnvName("ADMIN_PASSWORD")).toBe(true);
    expect(isSafePlainEnvName("API_KEY")).toBe(true);
    expect(isSafePlainEnvName("lowercase")).toBe(false);
    expect(isSafePlainEnvName("BAD-NAME")).toBe(false);
  });
});

describe("store install metadata", () => {
  test("matches app-specific config by canonical URL and module path only", () => {
    const listing: TcsListing = {
      id: "publisher/example",
      source: {
        url: "https://example.test/example.git",
        ref: "main",
        path: "./deploy/opentofu/",
      },
      kind: "app",
      surface: "service",
      provider: "example",
      category: "example",
      suggestedName: "example",
      name: { ja: "Example", en: "Example" },
      description: { ja: "Example", en: "Example" },
      badge: { ja: "追加", en: "Install" },
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    };

    expect(
      storeSourceMatchesListing(
        {
          url: "https://example.test/example",
          ref: "main",
          path: "deploy/opentofu",
        },
        listing,
      ),
    ).toBe(true);
    expect(
      storeSourceMatchesListing(
        {
          url: "https://example.test/example.git",
          path: "deploy/opentofu",
        },
        listing,
      ),
    ).toBe(true);
    expect(
      storeSourceMatchesListing(
        {
          url: "https://example.test/example.git",
          ref: "next",
          path: "deploy/opentofu",
        },
        listing,
      ),
    ).toBe(true);
    expect(
      storeSourceMatchesListing(
        {
          url: "https://example.test/example.git",
          path: "deploy/other",
        },
        listing,
      ),
    ).toBe(false);
  });

  test("finds direct-Git InstallConfigs by service-side URL/path with no ref authority", () => {
    const matching = installConfig({
      id: "cfg-matching",
      store: {
        source: {
          url: "https://example.test/example.git",
          ref: "old-display-hint",
          path: "./deploy/opentofu/",
        },
        order: 1,
        surface: "service",
        kind: "app",
        provider: "example",
        suggestedName: "example",
        badge: { ja: "追加", en: "Install" },
        name: { ja: "Example", en: "Example" },
        description: { ja: "Example", en: "Example" },
      },
    });
    const duplicate = installConfig({ ...matching, id: "cfg-duplicate" });
    const unrelated = installConfig({
      id: "cfg-unrelated",
      store: {
        ...matching.store!,
        source: {
          url: "https://example.test/other.git",
          path: "deploy/opentofu",
        },
      },
    });

    expect(
      storeInstallConfigsForSource(
        [matching, unrelated],
        "https://example.test/example",
        "deploy/opentofu",
      ).map((config) => config.id),
    ).toEqual(["cfg-matching"]);
    expect(
      storeInstallConfigsForSource(
        [matching, duplicate],
        "https://example.test/example.git",
        "deploy/opentofu",
      ),
    ).toHaveLength(2);
    expect(
      storeInstallConfigsForSource(
        [matching],
        "https://example.test/example.git",
        "other",
      ),
    ).toHaveLength(0);
  });

  test("preserves operator-defined kind and surface tokens", () => {
    const listing: TcsListing = {
      id: "publisher/custom",
      source: { url: "https://example.test/custom.git", path: "." },
      kind: "database.cluster",
      surface: "platform_component",
      provider: "example",
      category: "example",
      suggestedName: "custom",
      name: { ja: "Custom", en: "Custom" },
      description: { ja: "Custom", en: "Custom" },
      badge: { ja: "追加", en: "Install" },
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    };

    const metadata = storeMetadataFromStoreListing(listing);
    expect(metadata.kind).toBe("database.cluster");
    expect(metadata.surface).toBe("platform_component");
  });

  test("resolves only discriminated InstallConfig defaults", () => {
    const listing: TcsListing = {
      id: "publisher/example",
      source: { url: "https://example.test/example.git", path: "." },
      kind: "app",
      surface: "service",
      provider: "example",
      category: "example",
      suggestedName: "example",
      name: { ja: "Example", en: "Example" },
      description: { ja: "Example", en: "Example" },
      badge: { ja: "追加", en: "Install" },
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    };
    const config = installConfig({
      variablePresentation: [
        {
          name: "capsule_name",
          label: { ja: "名前", en: "Name" },
          defaultValue: { source: "capsule_name" },
        },
        {
          name: "scoped_name",
          label: { ja: "対象名", en: "Scoped name" },
          defaultValue: { source: "workspace_scoped_capsule_name" },
        },
        {
          name: "branch",
          label: { ja: "ブランチ", en: "Branch" },
          defaultValue: { source: "literal", value: "main" },
        },
      ],
      installExperience: undefined,
    });
    const entry = storeEntryFromStoreListing(listing, config);

    expect(
      storeDefaultInputValue(entry, entry.inputs[0]!, "team", "My Service"),
    ).toBe("my-service");
    expect(
      storeDefaultInputValue(entry, entry.inputs[1]!, "team", "My Service"),
    ).toBe("team-my-service");
    expect(
      storeDefaultInputValue(entry, entry.inputs[2]!, "team", "My Service"),
    ).toBe("main");
  });

  test("keeps listing metadata display-only and reads setup from InstallConfig", () => {
    const inputs = [
      {
        name: "public_subdomain",
        type: "string" as const,
        format: "subdomain" as const,
        required: true,
        label: { ja: "公開URL名", en: "Public URL name" },
      },
      {
        name: "auth_password",
        type: "string" as const,
        format: "password" as const,
        secret: true,
        label: { ja: "パスワード", en: "Password" },
      },
    ];
    const installExperience = {
      projections: [
        {
          kind: "public_endpoint" as const,
          variables: { subdomain: "public_subdomain" },
          baseDomain: "app.example.test",
        },
        {
          kind: "initial_secret" as const,
          variable: "auth_password",
          optional: true,
        },
      ],
    };
    const listing: TcsListing = {
      id: "publisher/example",
      source: {
        url: "https://example.test/example.git",
        ref: "v1.2.3",
        path: ".",
      },
      kind: "app",
      surface: "service",
      provider: "cloudflare",
      category: "example",
      suggestedName: "example",
      name: { ja: "Example", en: "Example" },
      description: { ja: "Example", en: "Example" },
      badge: { ja: "追加", en: "Install" },
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    };

    const metadata = storeMetadataFromStoreListing(listing);
    const config = installConfig({
      variablePresentation: inputs,
      installExperience,
    });
    const entry = storeEntryFromStoreListing(listing, config);

    expect(metadata).not.toHaveProperty("inputs");
    expect(metadata).not.toHaveProperty("installExperience");
    expect(metadata.source).toEqual({
      url: "https://example.test/example.git",
      path: ".",
    });
    expect(metadata.source).not.toHaveProperty("ref");
    expect(entry.inputs).toEqual(inputs);
    expect(entry.installExperience).toEqual(installExperience);
  });

  test("operator managed domain overrides the repository fallback in defaults", () => {
    const listing: TcsListing = {
      id: "publisher/example",
      source: { url: "https://example.test/example.git", path: "." },
      kind: "app",
      surface: "service",
      provider: "cloudflare",
      category: "example",
      suggestedName: "example",
      name: { ja: "Example", en: "Example" },
      description: { ja: "Example", en: "Example" },
      badge: { ja: "追加", en: "Install" },
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    };
    const config = installConfig({
      variablePresentation: [
        {
          name: "public_url",
          type: "string",
          format: "url",
          label: { ja: "公開URL", en: "Public URL" },
        },
      ],
      installExperience: {
        projections: [
          {
            kind: "public_endpoint",
            variables: { url: "public_url" },
            baseDomain: "app.takos.jp",
          },
        ],
      },
    });
    const entry = storeEntryFromStoreListing(listing, config);

    expect(
      storeDefaultInputValue(
        entry,
        entry.inputs[0]!,
        "workspace",
        "service",
        "app-staging.takos.jp",
      ),
    ).toBe("https://workspace-service.app-staging.takos.jp");
    expect(
      storeDefaultInputValue(
        entry,
        entry.inputs[0]!,
        "workspace",
        "service",
        "app-staging.takos.jp",
        "vanity",
      ),
    ).toBe("https://service.app-staging.takos.jp");
  });
});

function installConfig(fields: Partial<InstallConfig>): InstallConfig {
  return {
    id: "cfg-service-side",
    name: "service-side",
    sourceKind: "generic_capsule",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    ...fields,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}
