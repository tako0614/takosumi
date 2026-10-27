/**
 * Hosted-resource contribution client (lib/hosted-resources.ts). The
 * standalone hosted-resources screen left the UI (TASK-0115): an app's page
 * shows what that app created. The client stays for that page.
 */
import { expect, test } from "bun:test";
import {
  HOSTED_RESOURCE_INVENTORY_KIND,
  loadHostedResourceContribution,
  listHostedResourceInventoryPage,
  parsePlatformExtensionCatalog,
  parseHostedResourceInventory,
  resolveHostedResourceContribution,
} from "../../../../dashboard/src/lib/hosted-resources.ts";

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
