import { describe, expect, test } from "bun:test";
import {
  capsuleAbandonmentCompleted,
  compatibilityCheckLooksTransient,
  compatibilityDiagnosticDisplay,
  compatibilitySummaryDisplay,
  providerNameFromDiagnostic,
  isSafePlainEnvName,
  storeDefaultInputValue,
  storeEntryFromStoreListing,
  storeMetadataFromStoreListing,
  storeInstallConfigsForSource,
  storeInstallFeatures,
  storeInitialSecretField,
  storeSourceMatchesListing,
  storeUsesRepositoryInstallUx,
  uniqueStoreInstallConfigForSource,
  sourceBuildPreview,
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
      providerPackages: [],
      rootProviderRequirements: [],
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

  test("renders invalid repository setup as fixed actionable copy", () => {
    const diagnostic = {
      code: "repository_install_ux_invalid",
      severity: "error" as const,
      message: "secret-like raw compiler diagnostic",
      detail: "AUTH_PASSWORD_HASH=must-not-render",
    };
    const display = compatibilityDiagnosticDisplay(diagnostic);
    expect(display.technical).not.toBe(true);
    expect(display.message).not.toContain("AUTH_PASSWORD_HASH");
    expect(display.detail).not.toContain("AUTH_PASSWORD_HASH");
    expect(
      compatibilitySummaryDisplay({
        reportId: "report_1",
        sourceSnapshotId: "snapshot_1",
        level: "unsupported",
        summary: "raw",
        diagnostics: [diagnostic],
        providerPackages: [],
        rootProviderRequirements: [],
        resources: [],
        rootModuleVariables: [],
        source: "api",
      }),
    ).not.toContain("AUTH_PASSWORD_HASH");
  });
});

describe("failed initial install abandonment", () => {
  test("accepts the first response and a lost-ack retry only with destroyed readback", () => {
    expect(
      capsuleAbandonmentCompleted({
        abandoned: true,
        capsule: { status: "destroyed" },
      }),
    ).toBe(true);
    expect(
      capsuleAbandonmentCompleted({
        alreadyDeleted: true,
        capsule: { status: "destroyed" },
      }),
    ).toBe(true);
    expect(
      capsuleAbandonmentCompleted({
        alreadyDeleted: true,
        capsule: { status: "active" },
      }),
    ).toBe(false);
    expect(capsuleAbandonmentCompleted({ abandoned: true })).toBe(false);
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

describe("repository sourceBuild preview", () => {
  test("allowlists exact argv, working directories, and outputs without env fields", () => {
    expect(
      sourceBuildPreview({
        commands: [
          { argv: ["bun", "install"] },
          { argv: ["bun", "run", "build"], workingDirectory: "web" },
        ],
        outputs: ["web/dist/index.js"],
        env: { SECRET: "must-not-render" },
      }),
    ).toEqual({
      commands: [
        { argv: ["bun", "install"] },
        { argv: ["bun", "run", "build"], workingDirectory: "web" },
      ],
      outputs: ["web/dist/index.js"],
    });
    expect(
      sourceBuildPreview({
        commands: [{ argv: ["bun"] }],
        outputs: [{ path: "secret" }],
      }),
    ).toBeUndefined();
  });
});

describe("store install metadata", () => {
  test("matches Store metadata by canonical repository URL only", () => {
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
          path: "../not-authority",
        },
        listing,
      ),
    ).toBe(true);
  });

  test("finds only explicit Store-eligible overlays by URL", () => {
    const matching = installConfig({
      id: "cfg-matching",
      sourceSelector: {
        url: "https://example.test/example.git",
        path: "./deploy/opentofu/",
      },
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
    const generic = installConfig({
      id: "cfg-generic-same-url",
      sourceSelector: matching.sourceSelector,
    });
    const unrelated = installConfig({
      id: "cfg-unrelated",
      sourceSelector: {
        url: "https://example.test/other.git",
        path: "deploy/opentofu",
      },
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
      ).map((config) => config.id),
    ).toEqual(["cfg-matching"]);
    expect(
      storeInstallConfigsForSource(
        [matching, duplicate],
        "https://example.test/example.git",
      ),
    ).toHaveLength(2);
    expect(
      storeInstallConfigsForSource([generic], "https://example.test/example.git"),
    ).toEqual([]);
    expect(
      storeInstallConfigsForSource(
        [matching],
        "https://example.test/example.git",
      ),
    ).toHaveLength(1);
    expect(
      uniqueStoreInstallConfigForSource(
        [matching, unrelated],
        "https://example.test/example.git",
      )?.id,
    ).toBe("cfg-matching");
    expect(
      uniqueStoreInstallConfigForSource(
        [matching, duplicate],
        "https://example.test/example.git",
      ),
    ).toBeNull();
    // A presentation-only Store row must never fall back to the generic
    // direct-Git config: that creates an active Capsule without app Outputs or
    // a launcher Interface.
    expect(
      uniqueStoreInstallConfigForSource(
        [
          installConfig({
            id: "cfg-default-opentofu-capsule",
          }),
          installConfig({
            id: "cfg-presentation-only",
            store: matching.store,
          }),
        ],
        "https://example.test/example.git",
      ),
    ).toBeNull();
    expect(
      storeInstallConfigsForSource(
        [
          installConfig({
            id: "cfg-presentation-only",
            store: matching.store,
          }),
        ],
        "https://example.test/example.git",
      ),
    ).toHaveLength(0);
    expect(
      storeInstallConfigsForSource(
        [matching],
        "https://example.test/Example.git",
      ),
    ).toHaveLength(0);
  });

  test("ignores config module paths until the server resolves the Store module", () => {
    const nestedModule = installConfig({
      id: "cfg-nested-module",
      sourceSelector: {
        url: "https://example.test/example.git",
        path: ".",
      },
      modulePath: "deploy/opentofu",
      store: {
        source: {
          url: "https://example.test/example.git",
          path: "legacy/path",
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

    expect(
      uniqueStoreInstallConfigForSource(
        [nestedModule],
        "https://example.test/example.git",
      )?.id,
    ).toBe("cfg-nested-module");
    expect(
      uniqueStoreInstallConfigForSource(
        [nestedModule],
        "https://example.test/example.git",
        "another/legacy/path",
      ),
    ).toBe(nestedModule);
  });

  test("ignores incomplete legacy Store source rows instead of crashing the install view", () => {
    const missingUrl = installConfig({
      id: "cfg-missing-url",
      store: {
        source: { path: "deploy/opentofu" },
      } as InstallConfig["store"],
    });
    const missingPath = installConfig({
      id: "cfg-missing-path",
      store: {
        source: { url: "https://example.test/example.git" },
      } as InstallConfig["store"],
    });

    expect(() =>
      storeInstallConfigsForSource(
        [missingUrl, missingPath],
        "https://example.test/example.git",
        "deploy/opentofu",
      ),
    ).not.toThrow();
    expect(
      storeInstallConfigsForSource(
        [missingUrl, missingPath],
        "https://example.test/example.git",
        "deploy/opentofu",
      ),
    ).toEqual([]);
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
    });
    expect(metadata.source).not.toHaveProperty("ref");
    expect(entry.inputs).toEqual(inputs);
    expect(entry.installExperience).toEqual(installExperience);
  });

  test("normalizes malformed public rows instead of calling trim on undefined", () => {
    const malformedListing = {
      id: "publisher/malformed",
      source: { url: "https://example.test/malformed.git", path: "." },
      kind: "app",
      surface: "service",
      provider: undefined,
      category: "example",
      suggestedName: "malformed",
      name: { ja: undefined, en: "Malformed" },
      description: undefined,
      badge: { ja: undefined, en: undefined },
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    } as unknown as TcsListing;
    const config = installConfig({
      variablePresentation: [
        {
          name: "display_name",
          label: undefined,
        } as unknown as NonNullable<
          InstallConfig["variablePresentation"]
        >[number],
        {
          name: undefined,
          label: { ja: "壊れた値", en: "Broken" },
        } as unknown as NonNullable<
          InstallConfig["variablePresentation"]
        >[number],
      ],
      installExperience: {
        projections: [
          {
            kind: "service_name",
            variable: undefined,
          } as unknown as NonNullable<
            InstallConfig["installExperience"]
          >["projections"][number],
        ],
      },
    });

    expect(() =>
      storeEntryFromStoreListing(malformedListing, config),
    ).not.toThrow();
    const entry = storeEntryFromStoreListing(malformedListing, config);
    expect(entry.name).toEqual({ ja: "Malformed", en: "Malformed" });
    expect(entry.inputs).toHaveLength(1);
    expect(entry.inputs[0]?.label).toEqual({
      ja: "display_name",
      en: "display_name",
    });
    expect(entry.setupProjectionInvalid).toBe(true);
  });

  test("reads initial-secret and feature metadata only from compiled InstallConfig", () => {
    const config = installConfig({
      variablePresentation: [
        {
          name: "admin_password",
          type: "string",
          secret: true,
          label: { ja: "初期パスワード", en: "Initial password" },
        },
        {
          name: "push_token",
          type: "string",
          secret: true,
          label: { ja: "通知トークン", en: "Notification token" },
        },
      ],
      installExperience: {
        repositoryInstallUx: { status: "accepted" },
        projections: [
          {
            kind: "initial_secret",
            variable: "admin_password",
            secretKind: "password",
          },
        ],
        features: [
          {
            id: "notifications",
            label: { ja: "通知", en: "Notifications" },
            optional: true,
            inputs: ["push_token"],
          },
        ],
      },
    });
    const listing = {
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
    } satisfies TcsListing;
    const entry = storeEntryFromStoreListing(listing, config);

    expect(storeInitialSecretField(entry)?.name).toBe("admin_password");
    expect(storeInstallFeatures(entry).map((feature) => feature.id)).toEqual([
      "notifications",
    ]);
    expect(storeUsesRepositoryInstallUx(entry)).toBe(true);
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
