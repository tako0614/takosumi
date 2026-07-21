import { test, expect } from "bun:test";
import { Hono } from "hono";
import type { ActorContext, TakoformDeclaredInterface } from "takosumi-contract";
import { registerPortableFormHostRoutes } from "../../../core/api/form_host_routes.ts";

const BASE = "/apis/forms.takoform.com/v1alpha1";

const ACTOR: ActorContext = {
  actorAccountId: "acct_portable",
  roles: ["owner"],
  scopes: ["forms:read", "resources:*"],
  requestId: "req_portable",
};

const DECLARED: TakoformDeclaredInterface = {
  name: "mcp.server",
  version: "2025-11-25",
  document: { title: "MCP" },
  values: { endpoint: "https://example.test/mcp" },
};

function buildHost(
  declarations?: readonly TakoformDeclaredInterface[],
  onList?: (input: { readonly space: string; readonly name?: string }) => void,
) {
  const app = new Hono();
  registerPortableFormHostRoutes(app, {
    // Only the declaration surface is exercised here; the lifecycle routes have
    // their own coverage and never run in this test.
    service: {} as never,
    availability: {} as never,
    authorize: async () => ({ ok: true, actor: ACTOR }),
    canReadForms: () => true,
    ...(declarations
      ? {
          interfaceDeclarations: {
            listDeclaredInterfaces: async (input) => {
              onList?.({ space: input.space, name: input.name });
              return input.name
                ? declarations.filter((item) => item.name === input.name)
                : declarations;
            },
          },
        }
      : {}),
  });
  return app;
}

test("a host without declarations does not advertise or mount the surface", async () => {
  const app = buildHost();
  const discovery = await app.request("/.well-known/takoform");
  const body = await discovery.json();
  // An absent optional feature is a conforming posture, not an error.
  expect(body.features.interface_declarations).toBeUndefined();
  expect(body.endpoints.interfaces).toBeUndefined();
  expect(body.features.service_forms).toBe(true);
  expect((await app.request(`${BASE}/interfaces?space=space_1`)).status).toBe(
    404,
  );
});

test("a declaring host advertises the feature and its same-origin endpoint", async () => {
  const app = buildHost([DECLARED]);
  const discovery = await app.request("http://host.test/.well-known/takoform");
  const body = await discovery.json();
  expect(body.features.interface_declarations).toBe(true);
  expect(body.endpoints.interfaces).toBe(`http://host.test${BASE}/interfaces`);
  // The optional flag never displaces the required negotiation set.
  expect(body.features.exact_form_ref).toBe(true);
  expect(body.features.optimistic_concurrency).toBe(true);
  expect(body.features.idempotent_lifecycle).toBe(true);
});

test("the read lists declarations and reads one by name", async () => {
  const seen: { space: string; name?: string }[] = [];
  const app = buildHost([DECLARED], (input) => seen.push(input));
  const list = await app.request(`${BASE}/interfaces?space=space_1`);
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual({ interfaces: [DECLARED] });

  const one = await app.request(`${BASE}/interfaces/mcp.server?space=space_1`);
  expect(one.status).toBe(200);
  expect(await one.json()).toEqual(DECLARED);
  expect(seen).toEqual([
    { space: "space_1", name: undefined },
    { space: "space_1", name: "mcp.server" },
  ]);

  const missing = await app.request(`${BASE}/interfaces/other?space=space_1`);
  expect(missing.status).toBe(404);
  expect((await missing.json()).error.code).toBe("resource_not_found");
});

test("space is required and the surface is read-only", async () => {
  const app = buildHost([DECLARED]);
  const noSpace = await app.request(`${BASE}/interfaces`);
  expect(noSpace.status).toBe(400);
  expect((await noSpace.json()).error.code).toBe("invalid_argument");

  // There is no portable write: declarations are written through the host's
  // own fenced identity, never through this protocol.
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await app.request(`${BASE}/interfaces?space=space_1`, {
      method,
    });
    expect(response.status).toBe(404);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await app.request(
      `${BASE}/interfaces/mcp.server?space=space_1`,
      { method },
    );
    expect(response.status).toBe(404);
  }
});

test("an unauthenticated caller never reaches the declaration read", async () => {
  const app = new Hono();
  let called = false;
  registerPortableFormHostRoutes(app, {
    service: {} as never,
    availability: {} as never,
    authorize: async () => ({
      ok: false,
      response: new Response(null, { status: 401 }),
    }),
    canReadForms: () => true,
    interfaceDeclarations: {
      listDeclaredInterfaces: async () => {
        called = true;
        return [];
      },
    },
  });
  const response = await app.request(`${BASE}/interfaces?space=space_1`);
  expect(response.status).toBe(401);
  expect((await response.json()).error.code).toBe("unauthenticated");
  expect(called).toBe(false);
});
