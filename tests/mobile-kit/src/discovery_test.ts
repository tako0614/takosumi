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
        endpoints: {
          mobilePushRegistrations:
            "https://host.example/api/mobile/push-registrations",
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
  expect(discovery.oidcDiscoveryUrl).toBe(
    "https://issuer.example/.well-known/openid-configuration",
  );
  expect(discovery.product?.endpoints?.mobilePushRegistrations).toBe(
    "https://host.example/api/mobile/push-registrations",
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

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
