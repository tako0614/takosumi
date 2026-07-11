import { describe, expect, test } from "bun:test";
import {
  storeDefaultInputValue,
  storeEntryFromStoreListing,
  storeMetadataFromStoreListing,
} from "../../../../../dashboard/src/views/new/install-helpers.ts";
import type { TcsListing } from "../../../../../dashboard/src/lib/tcs-client.ts";

describe("store install metadata", () => {
  test("preserves repository-owned inputs and projections", () => {
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
      source: { git: "https://example.test/example.git", path: "." },
      kind: "app",
      surface: "service",
      provider: "cloudflare",
      category: "example",
      suggestedName: "example",
      name: { ja: "Example", en: "Example" },
      description: { ja: "Example", en: "Example" },
      badge: { ja: "追加", en: "Install" },
      inputs,
      installExperience,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    };

    const metadata = storeMetadataFromStoreListing(listing);

    expect(metadata.inputs).toEqual(inputs);
    expect(metadata.installExperience).toEqual(installExperience);
  });

  test("operator managed domain overrides the repository fallback in defaults", () => {
    const listing: TcsListing = {
      id: "publisher/example",
      source: { git: "https://example.test/example.git", path: "." },
      kind: "app",
      surface: "service",
      provider: "cloudflare",
      category: "example",
      suggestedName: "example",
      name: { ja: "Example", en: "Example" },
      description: { ja: "Example", en: "Example" },
      badge: { ja: "追加", en: "Install" },
      inputs: [
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
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    };
    const entry = storeEntryFromStoreListing(
      listing,
      "cfg-default-opentofu-capsule",
    );

    expect(
      storeDefaultInputValue(
        entry,
        entry.inputs[0]!,
        "workspace",
        "service",
        "app-staging.takos.jp",
      ),
    ).toBe("https://workspace-service.app-staging.takos.jp");
  });
});
