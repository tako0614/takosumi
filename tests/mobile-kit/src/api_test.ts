import { expect, test } from "bun:test";
import {
  createMobileApiClient,
  MOBILE_PUSH_REGISTRATION_PATH,
  registerMobilePushWithHost,
  resolveMobilePushRegistrationEndpoint,
  unregisterMobilePushWithHost,
  type MobileSession,
} from "../../../mobile-kit/src/index.ts";

test("createMobileApiClient sends bearer auth to host API", async () => {
  const requests: Request[] = [];
  const client = createMobileApiClient({
    session: session(),
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await client.json<{ ok: boolean }>("/api/auth/me");

  expect(result.ok).toBe(true);
  expect(requests[0].url).toBe("https://host.example/api/auth/me");
  expect(requests[0].headers.get("authorization")).toBe("Bearer access-1");
});

test("registerMobilePushWithHost posts typed push registration to host API", async () => {
  const requests: Request[] = [];

  await registerMobilePushWithHost({
    session: session({
      productEndpoints: {
        mobilePushRegistrations: "/custom/mobile-push",
      },
    }),
    registration: {
      token: "push-token",
      environment: "production",
    },
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  expect(requests[0].url).toBe("https://host.example/custom/mobile-push");
  expect(requests[0].method).toBe("POST");
  expect(requests[0].headers.get("authorization")).toBe("Bearer access-1");
  expect(requests[0].headers.get("content-type")).toBe("application/json");
  expect(await requests[0].json()).toEqual({
    token: "push-token",
    environment: "production",
    product: "takos",
    host_url: "https://host.example",
  });
});

test("registerMobilePushWithHost accepts same-origin advertised absolute endpoints", async () => {
  const requests: Request[] = [];

  await registerMobilePushWithHost({
    session: session({
      productEndpoints: {
        mobilePushRegistrations:
          "https://host.example/api/mobile/push-registrations",
      },
    }),
    registration: {
      token: "push-token",
    },
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  expect(requests[0].url).toBe(
    "https://host.example/api/mobile/push-registrations",
  );
});

test("unregisterMobilePushWithHost deletes typed push registration from host API", async () => {
  const requests: Request[] = [];

  await unregisterMobilePushWithHost({
    session: session(),
    registration: {
      token: "push-token",
      environment: "production",
    },
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  expect(requests[0].url).toBe(
    "https://host.example/api/mobile/push-registrations",
  );
  expect(requests[0].method).toBe("DELETE");
  expect(requests[0].headers.get("authorization")).toBe("Bearer access-1");
  expect(requests[0].headers.get("content-type")).toBe("application/json");
  expect(await requests[0].json()).toEqual({
    token: "push-token",
    environment: "production",
    product: "takos",
    host_url: "https://host.example",
  });
});

test("registerMobilePushWithHost rejects cross-origin advertised endpoints", async () => {
  await expect(
    registerMobilePushWithHost({
      session: session({
        productEndpoints: {
          mobilePushRegistrations: "https://evil.example/mobile-push",
        },
      }),
      registration: {
        token: "push-token",
      },
      fetch: async () => {
        throw new Error("must not send request");
      },
    }),
  ).rejects.toThrow("Host endpoint must stay on the connected host.");
});

test("resolveMobilePushRegistrationEndpoint falls back to the standard path", () => {
  expect(resolveMobilePushRegistrationEndpoint(session())).toBe(
    MOBILE_PUSH_REGISTRATION_PATH,
  );
});

function session(input: Partial<MobileSession> = {}): MobileSession {
  return {
    hostUrl: "https://host.example",
    product: "takos",
    oidcIssuer: "https://host.example",
    accessToken: "access-1",
    tokenType: "Bearer",
    createdAt: "2026-06-30T00:00:00.000Z",
    ...input,
  };
}
