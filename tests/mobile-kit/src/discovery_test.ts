import { expect, test } from "bun:test";
import { discoverHost, type FetchLike } from "../../../mobile-kit/src/index.ts";

test("discoverHost reads Takosumi, capabilities, product, and OIDC issuer", async () => {
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/takosumi")) {
      return json({ issuer: "https://issuer.example", product: "takos" });
    }
    if (url.endsWith("/v1/capabilities")) {
      return json({ identity: { oidc_issuer: true } });
    }
    if (url.endsWith("/.well-known/takos")) {
      return json({
        product: "takos",
        name: "Takos",
        oidcClientId: "takos-mobile-host-example",
        endpoints: {
          notificationPushers: "https://host.example/api/notifications/pushers",
        },
      });
    }
    return new Response("", { status: 404 });
  };

  const discovery = await discoverHost({
    hostUrl: "https://host.example/path",
    expectedProduct: "takos",
    fetch: fetcher,
  });

  expect(discovery.hostUrl).toBe("https://host.example");
  expect(discovery.detectedProduct).toBe("takos");
  expect(discovery.oidcIssuer).toBe("https://issuer.example");
  expect(discovery.oidcClientId).toBe("takos-mobile-host-example");
  expect(discovery.oidcDiscoveryUrl).toBe(
    "https://issuer.example/.well-known/openid-configuration",
  );
  expect(discovery.product?.endpoints?.notificationPushers).toBe(
    "https://host.example/api/notifications/pushers",
  );
});

test("discoverHost reads Yurucommu product discovery", async () => {
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/yurucommu")) {
      return json({
        product: "yurucommu",
        name: "Yurucommu",
        issuer: "https://accounts.example",
        apiBaseUrl: "https://social.example",
        endpoints: {
          currentUser: "https://social.example/api/auth/me",
          mobilePushRegistrations:
            "https://social.example/api/mobile/push-registrations",
        },
      });
    }
    return new Response("", { status: 404 });
  };

  const discovery = await discoverHost({
    hostUrl: "https://social.example",
    expectedProduct: "yurucommu",
    fetch: fetcher,
  });

  expect(discovery.detectedProduct).toBe("yurucommu");
  expect(discovery.oidcIssuer).toBe("https://accounts.example");
  expect(discovery.product?.endpoints?.mobilePushRegistrations).toBe(
    "https://social.example/api/mobile/push-registrations",
  );
});

test("discoverHost reads the current Takosumi well-known endpoints shape", async () => {
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/takosumi")) {
      return json({
        api_versions: ["takosumi.dev/v1alpha1"],
        endpoints: {
          api: "https://host.example/api",
          capabilities: "https://host.example/v1/capabilities",
          oidc_issuer: "https://host.example",
        },
      });
    }
    if (url.endsWith("/v1/capabilities")) return json({});
    return new Response("", { status: 404 });
  };

  const discovery = await discoverHost({
    hostUrl: "https://host.example",
    expectedProduct: "takos",
    fetch: fetcher,
  });

  expect(discovery.detectedProduct).toBeUndefined();
  expect(discovery.oidcIssuer).toBe("https://host.example");
  expect(discovery.oidcDiscoveryUrl).toBe(
    "https://host.example/.well-known/openid-configuration",
  );
});

test("discoverHost accepts product discovery from the Takosumi well-known document", async () => {
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/takosumi")) {
      return json({
        product: "notes-app",
        issuer: "https://notes.example",
        endpoints: {
          api: "https://notes.example/api",
          oidc_issuer: "https://notes.example",
        },
      });
    }
    if (url.endsWith("/v1/capabilities")) return json({});
    return new Response("", { status: 404 });
  };

  const discovery = await discoverHost({
    hostUrl: "https://notes.example",
    expectedProduct: "notes-app",
    fetch: fetcher,
  });

  expect(discovery.detectedProduct).toBe("notes-app");
  expect(discovery.oidcIssuer).toBe("https://notes.example");
});

test("discoverHost rejects mismatched products", async () => {
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/takosumi"))
      return json({ product: "takos" });
    if (url.endsWith("/v1/capabilities")) return json({});
    if (url.endsWith("/.well-known/yurucommu"))
      return json({ product: "takos" });
    return new Response("", { status: 404 });
  };

  await expect(
    discoverHost({
      hostUrl: "https://host.example",
      expectedProduct: "yurucommu",
      fetch: fetcher,
    }),
  ).rejects.toThrow("Host is takos, not yurucommu.");
});

test("discoverHost requires an explicitly advertised OIDC issuer", async () => {
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/takos")) {
      return json({
        product: "takos",
        oidcClientId: "takos-mobile-host-example",
      });
    }
    if (url.endsWith("/v1/capabilities")) return json({});
    return new Response("", { status: 404 });
  };

  await expect(
    discoverHost({
      hostUrl: "https://host.example",
      expectedProduct: "takos",
      fetch: fetcher,
    }),
  ).rejects.toThrow("Host does not advertise an OIDC issuer.");
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
