import { describe, expect, test } from "bun:test";
import { TAKOSUMI_API_VERSION } from "takosumi-contract";
import {
  installConfigRequiresUiSurface,
  isReadyUiOpenBinding,
  listAuthorizedUiSurfaces,
  parseUiSurfaceInterface,
} from "../../../../dashboard/src/lib/ui-surface-interfaces.ts";

test("identifies install configs whose launcher must be read back", () => {
  const launcher = {
    key: "launcher",
    name: "app.launcher",
    spec: {
      type: "interface.ui.surface",
      version: "1",
      document: { launcher: true },
      access: { visibility: "workspace" },
    },
    bindings: [
      {
        key: "launcher.installer",
        subject: { source: "installing_principal" },
        permissions: ["ui.open"],
        delivery: { type: "none" },
      },
    ],
  } as const;

  expect(installConfigRequiresUiSurface([launcher])).toBe(true);
  expect(
    installConfigRequiresUiSurface([
      { ...launcher, bindings: [{ ...launcher.bindings[0], permissions: [] }] },
    ]),
  ).toBe(false);
  expect(
    installConfigRequiresUiSurface([
      { ...launcher, spec: { ...launcher.spec, type: "interface.mcp" } },
    ]),
  ).toBe(false);
  expect(installConfigRequiresUiSurface(undefined)).toBe(false);
});

function uiInterface(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "Interface",
    metadata: {
      id: "if_ui",
      workspaceId: "ws_1",
      name: "app.launcher",
      ownerRef: { kind: "Capsule", id: "cap_1" },
      generation: 2,
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    },
    spec: {
      type: "interface.ui.surface",
      version: "1",
      document: {
        launcher: true,
        display: {
          title: "Office",
          description: "Documents",
          icon: "/icon.svg",
          category: "productivity",
          sortOrder: 7,
        },
      },
      inputs: {
        url: {
          source: "capsule_output",
          capsuleId: "cap_1",
          outputName: "ordinary_url",
        },
      },
      access: { visibility: "workspace" },
    },
    status: {
      phase: "Resolved",
      observedGeneration: 2,
      resolvedRevision: 4,
      resolvedInputs: { url: "https://office.example.test/app" },
    },
    ...overrides,
  };
}

function readyBinding(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    apiVersion: TAKOSUMI_API_VERSION,
    kind: "InterfaceBinding",
    metadata: {
      id: "ifb_ui",
      workspaceId: "ws_1",
      generation: 1,
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    },
    spec: {
      interfaceId: "if_ui",
      subjectRef: { kind: "Principal", id: "acct_1" },
      permissions: ["ui.open"],
      delivery: { type: "none" },
    },
    status: {
      phase: "Ready",
      observedInterfaceRevision: 4,
    },
    ...overrides,
  };
}

describe("dashboard UI-surface Interface consumer", () => {
  test("accepts only the exact Capsule launcher profile", () => {
    const parsed = parseUiSurfaceInterface(uiInterface(), "ws_1");
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      interfaceId: "if_ui",
      capsuleId: "cap_1",
      resolvedRevision: 4,
      name: "Office",
      icon: "https://office.example.test/icon.svg",
      category: "productivity",
      sortOrder: 7,
      url: "https://office.example.test/app",
    });

    const resourceOwned = uiInterface({
      metadata: {
        ...(uiInterface().metadata as Record<string, unknown>),
        ownerRef: { kind: "Resource", id: "resource_1" },
      },
    });
    expect(parseUiSurfaceInterface(resourceOwned, "ws_1")).toBeNull();
  });

  test("accepts an explicitly related Resource-owned opaque launcher without guessing its type or Output name", () => {
    const base = uiInterface();
    const parsed = parseUiSurfaceInterface(
      {
        ...base,
        launcherOwner: { capsuleId: "cap_1" },
        metadata: {
          ...(base.metadata as Record<string, unknown>),
          ownerRef: { kind: "Resource", id: "tkrn:space_1:HttpService:yuru" },
        },
        spec: {
          type: "yuru.application",
          version: "2026-07-29",
          document: {
            launcher: true,
            display: { title: "Yurucommu" },
            endpoint: { originInput: "public_origin", path: "/chat" },
          },
          inputs: {
            public_origin: {
              source: "resource_output",
              resourceId: "tkrn:space_1:HttpService:yuru",
              pointer: "/service/endpoint",
            },
          },
          access: { visibility: "workspace" },
        },
        status: {
          phase: "Resolved",
          observedGeneration: 2,
          resolvedRevision: 4,
          resolvedInputs: {
            public_origin: "https://yuru.example.test/base",
          },
        },
      },
      "ws_1",
    );
    expect(parsed).toMatchObject({
      interfaceId: "if_ui",
      capsuleId: "cap_1",
      name: "Yurucommu",
      url: "https://yuru.example.test/chat",
    });
  });

  test("fails closed for stale revisions, undeclared URL inputs, and embedded credentials", () => {
    const base = uiInterface();
    expect(
      parseUiSurfaceInterface(
        {
          ...base,
          status: {
            ...(base.status as Record<string, unknown>),
            observedGeneration: 1,
          },
        },
        "ws_1",
      ),
    ).toBeNull();

    const unsafeIcon = parseUiSurfaceInterface(
      {
        ...base,
        spec: {
          ...(base.spec as Record<string, unknown>),
          document: {
            launcher: true,
            display: { title: "Office", icon: "javascript:alert(1)" },
          },
        },
      },
      "ws_1",
    );
    expect(unsafeIcon).not.toBeNull();
    expect(unsafeIcon?.icon).toBeUndefined();
    expect(
      parseUiSurfaceInterface(
        {
          ...base,
          spec: {
            ...(base.spec as Record<string, unknown>),
            inputs: {},
          },
        },
        "ws_1",
      ),
    ).toBeNull();
    expect(
      parseUiSurfaceInterface(
        {
          ...base,
          spec: {
            ...(base.spec as Record<string, unknown>),
            document: { launcher: true, auth: "query-token" },
          },
        },
        "ws_1",
      ),
    ).toBeNull();
    expect(
      parseUiSurfaceInterface(
        {
          ...base,
          status: {
            ...(base.status as Record<string, unknown>),
            resolvedInputs: {
              url: "https://office.example.test/app?token=secret",
            },
          },
        },
        "ws_1",
      ),
    ).toBeNull();
  });

  test("requires an exact Ready Principal Binding for the current revision", () => {
    const parsed = parseUiSurfaceInterface(uiInterface(), "ws_1");
    expect(parsed).not.toBeNull();
    expect(
      isReadyUiOpenBinding(readyBinding(), parsed!.interface, "acct_1"),
    ).toBeTrue();
    expect(
      isReadyUiOpenBinding(
        readyBinding({
          status: { phase: "Ready", observedInterfaceRevision: 3 },
        }),
        parsed!.interface,
        "acct_1",
      ),
    ).toBeFalse();
    expect(
      isReadyUiOpenBinding(
        readyBinding({
          spec: {
            ...(readyBinding().spec as Record<string, unknown>),
            subjectRef: { kind: "Principal", id: "acct_other" },
          },
        }),
        parsed!.interface,
        "acct_1",
      ),
    ).toBeFalse();
  });

  test("lists only Interfaces authorized for the signed-in Principal", async () => {
    const calls: string[] = [];
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const path = String(input);
      calls.push(path);
      if (path.startsWith("/api/v1/workspaces/ws_1/ui-surfaces")) {
        return Response.json({ interfaces: [uiInterface()] });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    };

    await expect(
      listAuthorizedUiSurfaces("ws_1", {
        fetch: fetcher,
        capsuleId: "cap_1",
      }),
    ).resolves.toEqual([
      {
        interfaceId: "if_ui",
        capsuleId: "cap_1",
        resolvedRevision: 4,
        name: "Office",
        description: "Documents",
        icon: "https://office.example.test/icon.svg",
        category: "productivity",
        sortOrder: 7,
        url: "https://office.example.test/app",
      },
    ]);
    expect(calls).toEqual([
      "/api/v1/workspaces/ws_1/ui-surfaces?capsuleId=cap_1",
    ]);

    calls.length = 0;
    await expect(
      listAuthorizedUiSurfaces("ws_1", {
        fetch: fetcher,
        capsuleId: "cap_other",
      }),
    ).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("follows every pagination cursor instead of truncating the launcher list", async () => {
    const interfaces = Array.from({ length: 101 }, (_, index) => {
      const base = uiInterface();
      return uiInterface({
        metadata: {
          ...(base.metadata as Record<string, unknown>),
          id: `if_ui_${index}`,
          name: `app.launcher.${index}`,
        },
      });
    });
    const calls: string[] = [];
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const path = String(input);
      calls.push(path);
      if (path === "/api/v1/workspaces/ws_1/ui-surfaces") {
        return Response.json({
          interfaces: interfaces.slice(0, 100),
          nextCursor: "page_2",
        });
      }
      if (path === "/api/v1/workspaces/ws_1/ui-surfaces?cursor=page_2") {
        return Response.json({ interfaces: interfaces.slice(100) });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    };

    const surfaces = await listAuthorizedUiSurfaces("ws_1", {
      fetch: fetcher,
    });

    expect(surfaces).toHaveLength(101);
    expect(surfaces.some((surface) => surface.interfaceId === "if_ui_100")).toBe(
      true,
    );
    expect(calls).toEqual([
      "/api/v1/workspaces/ws_1/ui-surfaces",
      "/api/v1/workspaces/ws_1/ui-surfaces?cursor=page_2",
    ]);
  });

  test("fails closed for an invalid pagination cursor", async () => {
    const fetcher = async (): Promise<Response> =>
      Response.json({ interfaces: [uiInterface()], nextCursor: "" });

    await expect(
      listAuthorizedUiSurfaces("ws_1", { fetch: fetcher }),
    ).rejects.toThrow("UI surface list pagination cursor is invalid");
  });
});
