import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HOSTED_RESOURCES_SLOT,
  HOSTED_RESOURCE_INVENTORY_KIND,
  hostedResourceInventoryQuery,
  loadHostedResourceContribution,
  listHostedResourceInventoryPage,
  parsePlatformExtensionCatalog,
  parseHostedResourceInventory,
  resolveHostedResourceContribution,
} from "../../../../../dashboard/src/lib/hosted-resources.ts";
import { filterByContributionSlots } from "../../../../../dashboard/src/lib/platform-contributions.ts";

const dashboardRoot = resolve(import.meta.dir, "../../../../../dashboard/src");
const read = (path: string) =>
  readFileSync(resolve(dashboardRoot, path), "utf8");

test("hosted resources are a manage route backed by the native contribution", () => {
  const router = read("index.tsx");
  const nav = read("views/account/components/shell/nav.ts");
  const manage = read("views/settings/ManageView.tsx");

  expect(router).toContain("HostedResourcesView");
  expect(router).toContain(
    '<Route path="/settings/manage/hosted-resources" component={HostedResourcesView} />',
  );
  expect(nav).toContain('href: "/settings/manage/hosted-resources"');
  expect(nav).toContain(
    "requiresContributionSlot: HOSTED_RESOURCES_SLOT",
  );
  expect(manage).toContain("MANAGE_DESTINATIONS");
  expect(manage).toContain("loadHostedResourceContribution");
  expect(manage).toContain("filterByContributionSlots");
  expect(manage).not.toContain("<For each={MANAGE_DESTINATIONS}>");
  expect(manage).not.toContain('href="/resources"');
  expect(router).not.toContain('path="/resources"');
  expect(router).not.toContain("import(\"./views/resources/");
});

test("manage catalog hides retired hosted destination without its native contribution", () => {
  const destinations = [
    { href: "/settings/manage/hosted-resources" },
    { href: "/workloads" },
  ] as const;
  const withoutHostedResources = filterByContributionSlots(
    [
      { ...destinations[0], requiresContributionSlot: HOSTED_RESOURCES_SLOT },
      destinations[1],
    ],
    [],
  );
  expect(
    withoutHostedResources.some(
      (destination) =>
        destination.href === "/settings/manage/hosted-resources",
    ),
  ).toBe(false);

  const withHostedResources = filterByContributionSlots(
    [
      { ...destinations[0], requiresContributionSlot: HOSTED_RESOURCES_SLOT },
      destinations[1],
    ],
    [HOSTED_RESOURCES_SLOT],
  );
  expect(
    withHostedResources.some(
      (destination) =>
        destination.href === "/settings/manage/hosted-resources",
    ),
  ).toBe(true);
  expect(withHostedResources.length).toBe(2);
});

test("retired direct path keeps inventory loading disabled without a contribution", () => {
  expect(
    hostedResourceInventoryQuery(undefined, "workspace_1"),
  ).toBeUndefined();
  expect(
    hostedResourceInventoryQuery(
      { href: "/extensions/hosted-resources/inventory" },
      undefined,
    ),
  ).toBeUndefined();
  expect(
    hostedResourceInventoryQuery(
      { href: "/extensions/hosted-resources/inventory" },
      "workspace_1",
    ),
  ).toEqual({
    href: "/extensions/hosted-resources/inventory",
    workspaceId: "workspace_1",
  });
  const view = read("views/settings/HostedResourcesView.tsx");
  expect(view).toContain("hostedResourceInventoryQuery(");
  expect(view).toContain("createResource(\n    query,");
});

test(
  "hosted resource view uses the native contribution and provider-neutral inventory DTO",
  () => {
    const view = read("views/settings/HostedResourcesView.tsx");
    const client = read("lib/hosted-resources.ts");

    expect(view).not.toContain("loadPlatformContributions");
    expect(view).not.toContain("platformContributionsForSlot");
    expect(view).not.toContain("hasPlatformExtensionCapability");
    expect(view).toContain("loadHostedResourceContribution");
    expect(view).toContain("contribution.latest");
    expect(view).toContain("HostedResourceInventory");
    expect(view).toContain("currentWorkspaceId");
    expect(view).toContain(
      'href={`/workloads/${encodeURIComponent(item.workloadId)}`}',
    );
    expect(view).toContain('t("hostedResources.column.kind")');
    expect(view).toContain('t("hostedResources.column.name")');
    expect(view).toContain('t("hostedResources.column.status")');
    expect(view).toContain('t("hostedResources.column.generation")');
    expect(view).not.toContain("backendHandle");
    expect(view).not.toContain("providerId");
    expect(view).not.toContain("spec");
    expect(view).not.toContain("outputs");
    expect(view).not.toContain("delete");
    expect(view).not.toContain("update");
    expect(client).toContain(
      '"takosumi.hosted-resource-inventory@v1"',
    );
    expect(client).toContain("nextCursor");
    expect(client).toContain("workspaceId");
    expect(client).toContain("__takosumi/platform/extensions");
  },
);

const hostedExtension = (overrides: Record<string, unknown> = {}) => ({
  basePath: "/extensions/hosted-resources",
  configured: true,
  capabilities: ["hosted-resource.inventory.v1"],
  authMode: "platform",
  requiredScopes: ["resources:read"],
  selfServicePatScopes: ["resources:read"],
  workspaceContext: "query-required",
  contributions: [
    {
      id: "hosted-resources",
      slot: "workspace.hosted-resources",
      href: "/extensions/hosted-resources/inventory",
      presentation: "native",
      label: "Hosted resources",
    },
  ],
  ...overrides,
});

const catalog = (extensions: readonly Record<string, unknown>[]) => ({
  kind: "takosumi.platform-extensions@v1",
  generatedAt: "2026-08-16T00:00:00.000Z",
  serviceUrl: "https://operator.example",
  extensions,
  summary: {
    total: extensions.length,
    configured: extensions.filter((extension) => extension.configured).length,
    missing: extensions.filter((extension) => !extension.configured).length,
  },
});

test("hosted catalog resolves one configured same-owner native contribution", () => {
  const resolved = resolveHostedResourceContribution(
    parsePlatformExtensionCatalog(catalog([hostedExtension()])),
  );
  expect(resolved).toEqual({
    href: "/extensions/hosted-resources/inventory",
  });
});

test("hosted catalog never combines a capability owner with another href owner", () => {
  const malicious = catalog([
    hostedExtension({ contributions: [] }),
    {
      basePath: "/extensions/weak",
      configured: true,
      contributions: [
        {
          id: "weak",
          slot: "workspace.hosted-resources",
          href: "/extensions/weak/inventory",
          presentation: "native",
          label: "Weak hosted resources",
        },
      ],
    },
  ]);

  expect(() =>
    resolveHostedResourceContribution(parsePlatformExtensionCatalog(malicious)),
  ).toThrow();
});

test("hosted catalog rejects ambiguous owners and native contributions", () => {
  expect(() =>
    resolveHostedResourceContribution(
      parsePlatformExtensionCatalog(
        catalog([hostedExtension(), hostedExtension({ basePath: "/extensions/other" })]),
      ),
    ),
  ).toThrow();

  expect(() =>
    resolveHostedResourceContribution(
      parsePlatformExtensionCatalog(
        catalog([
          hostedExtension({
            contributions: [
              ...((hostedExtension().contributions as readonly unknown[]) ?? []),
              {
                id: "second",
                slot: "workspace.hosted-resources",
                href: "/extensions/hosted-resources/other",
                presentation: "native",
                label: "Second",
              },
            ],
          }),
        ]),
      ),
    ),
  ).toThrow();
});

test("hosted catalog requires an exact GET scope for request-rule routes", () => {
  const extension = hostedExtension({
    requiredScopes: undefined,
    requestScopeRules: [
      {
        path: "/inventory",
        methods: ["GET"],
        requiredScopes: ["resources:read"],
      },
    ],
  });
  expect(
    resolveHostedResourceContribution(
      parsePlatformExtensionCatalog(catalog([extension])),
    ),
  ).toEqual({ href: "/extensions/hosted-resources/inventory" });

  expect(() =>
    resolveHostedResourceContribution(
      parsePlatformExtensionCatalog(
        catalog([
          hostedExtension({
            requiredScopes: undefined,
            requestScopeRules: [
              {
                path: "/other",
                methods: ["GET"],
                requiredScopes: ["resources:read"],
              },
            ],
          }),
        ]),
      ),
    ),
  ).toThrow();
});

test("hosted catalog accepts canonical public OPTIONS request rules", () => {
  const cloudAiGateway = {
    id: "cloud-ai-gateway",
    basePath: "/api/v1/ai",
    configured: true,
    requestScopeRules: [
      {
        path: "/models",
        methods: ["GET", "HEAD"],
        requiredScopes: ["ai.models.read"],
      },
      {
        path: "/chat/completions",
        methods: ["POST"],
        requiredScopes: ["ai.chat"],
      },
      {
        path: "/chat/completions",
        methods: ["OPTIONS"],
        requiredScopes: [],
      },
    ],
  } as const;
  const parsed = parsePlatformExtensionCatalog(
    catalog([cloudAiGateway, hostedExtension()]),
  );

  expect(parsed.extensions[0]?.requestScopeRules?.[2]?.requiredScopes).toEqual(
    [],
  );
  expect(resolveHostedResourceContribution(parsed)).toEqual({
    href: "/extensions/hosted-resources/inventory",
  });
  expect(() =>
    parsePlatformExtensionCatalog(
      catalog([hostedExtension({ requiredScopes: [] })]),
    ),
  ).toThrow();
});

test("hosted catalog rejects malformed descriptors and unsafe contribution routes", () => {
  expect(() =>
    parsePlatformExtensionCatalog(
      catalog([hostedExtension({ capabilities: "hosted-resource.inventory.v1" })]),
    ),
  ).toThrow();
  expect(() =>
    resolveHostedResourceContribution(
      parsePlatformExtensionCatalog(
        catalog([
          hostedExtension({
            matchMode: "exact",
            contributions: [
              {
                id: "hosted-resources",
                slot: "workspace.hosted-resources",
                href: "/extensions/hosted-resources/inventory/detail",
                presentation: "native",
                label: "Hosted resources",
              },
            ],
          }),
        ]),
      ),
    ),
  ).toThrow();
});

test("hosted catalog loader authenticates and returns only the resolved href", async () => {
  const requests: Array<{ readonly input: string; readonly init?: RequestInit }> = [];
  const resolved = await loadHostedResourceContribution(async (input, init) => {
    requests.push({ input: String(input), init });
    return Response.json(catalog([hostedExtension()]));
  });
  expect(resolved).toEqual({
    href: "/extensions/hosted-resources/inventory",
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.input).toBe("/__takosumi/platform/extensions");
  expect(requests[0]?.init).toMatchObject({
    method: "GET",
    credentials: "include",
  });
});

test("hosted resource UI has unavailable, loading, retry, empty, and pagination states", () => {
  const view = read("views/settings/HostedResourcesView.tsx");
  const css = read("styles/app-views.css");
  const ja = read("i18n/ja.ts");
  const en = read("i18n/en.ts");

  for (const key of [
    "hostedResources.unavailableTitle",
    "hostedResources.loadError",
    "hostedResources.emptyTitle",
    "hostedResources.loadMore",
  ]) {
    expect(view).toContain(`t("${key}")`);
    expect(ja).toContain(`"${key}"`);
    expect(en).toContain(`"${key}"`);
  }
  expect(view).toContain('t("common.retry")');
  expect(view).toContain('t("common.loading")');
  expect(view).toContain('class="hosted-resources-table"');
  expect(view).toContain('class="hosted-resources-cards"');
  expect(css).toContain(".hosted-resources-table");
  expect(css).toContain(".hosted-resources-cards");
});

test("hosted inventory parsing is strict about version, workspace, and shape", () => {
  const item = {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "EdgeWorker",
    name: "api",
    formRef: {
      apiVersion: "takoform.takosumi.dev/v1",
      kind: "EdgeWorker",
      definitionVersion: "3.0.0",
      schemaDigest: "sha256:abc",
    },
    uid: "uid_1",
    generation: "4",
    revision: "8",
    conditions: [
      {
        type: "Ready",
        status: "True",
        reason: "Applied",
        lastTransitionTime: "2026-08-16T00:00:00Z",
      },
    ],
  } as const;
  const page = parseHostedResourceInventory(
    {
      kind: HOSTED_RESOURCE_INVENTORY_KIND,
      workspaceId: "workspace_1",
      items: [item],
      nextCursor: "opaque-cursor",
    },
    "workspace_1",
  );
  expect(page.items[0]).toEqual(item);
  expect(page.nextCursor).toBe("opaque-cursor");
  expect(() =>
    parseHostedResourceInventory(
      { kind: "resources.v1", workspaceId: "workspace_1", items: [] },
      "workspace_1",
    ),
  ).toThrow();
  expect(
    parseHostedResourceInventory(
      { kind: HOSTED_RESOURCE_INVENTORY_KIND, workspaceId: "workspace_1", items: [{ ...item, conditions: [] }] },
      "workspace_1",
    ).items[0]?.conditions,
  ).toEqual([]);
  for (const value of ["", "01", "+1", "-1", "1.0", "9".repeat(129)]) {
    expect(() =>
      parseHostedResourceInventory(
        {
          kind: HOSTED_RESOURCE_INVENTORY_KIND,
          workspaceId: "workspace_1",
          items: [{ ...item, generation: value }],
        },
        "workspace_1",
      ),
    ).toThrow();
  }
  expect(() =>
    parseHostedResourceInventory(
      { kind: HOSTED_RESOURCE_INVENTORY_KIND, workspaceId: "other", items: [] },
      "workspace_1",
    ),
  ).toThrow();
  expect(() =>
    parseHostedResourceInventory(
      {
        kind: HOSTED_RESOURCE_INVENTORY_KIND,
        workspaceId: "workspace_1",
        items: [{ ...item, providerId: "should-not-be-accepted" }],
      },
      "workspace_1",
    ),
  ).toThrow();
});

test("hosted inventory requests preserve the contribution href and opaque cursor", async () => {
  let requested = "";
  const page = await listHostedResourceInventoryPage(
    "/extensions/hosted/marketplace/resources?view=compact",
    "workspace_1",
    "opaque.cursor/2",
    async (input) => {
      requested = String(input);
      return Response.json({
        kind: HOSTED_RESOURCE_INVENTORY_KIND,
        workspaceId: "workspace_1",
        items: [],
      });
    },
  );
  const url = new URL(requested);
  expect(url.pathname).toBe("/extensions/hosted/marketplace/resources");
  expect(url.searchParams.get("view")).toBe("compact");
  expect(url.searchParams.get("workspaceId")).toBe("workspace_1");
  expect(url.searchParams.get("limit")).toBe("25");
  expect(url.searchParams.get("cursor")).toBe("opaque.cursor/2");
  expect(page.items).toEqual([]);
});
