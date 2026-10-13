import { expect, test } from "bun:test";
import { InMemoryAccountsStore } from "@takosjp/takosumi-accounts-service";
import { buildComposedApp } from "../../../deploy/node-postgres/src/composed-app.ts";
import { parseEnv } from "../../../deploy/node-postgres/src/handler.ts";
import {
  loadTakosumiRuntimeCapabilities,
  runtimeStoreUrl,
} from "../../../dashboard/src/lib/runtime-capabilities.ts";
import { getTcsServers } from "../../../dashboard/src/lib/tcs-servers.ts";

const origin = "http://localhost:26401";

async function loadFromServer(endpoint: string | undefined): Promise<void> {
  const { app } = await buildComposedApp({
    config: parseEnv({
      TAKOSUMI_ACCOUNTS_ISSUER: origin,
      TAKOSUMI_ACCOUNTS_DATABASE_URL: "postgres://unused",
    }),
    store: new InMemoryAccountsStore(),
    accountsHandler: async () => {
      throw new Error("Store discovery must be owned by the composed server");
    },
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_TCS_STORE_URL: endpoint,
    },
  });
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    return app.fetch(new Request(url));
  };
  await loadTakosumiRuntimeCapabilities(fetchImpl, origin);
  expect(requests).toEqual([
    `${origin}/.well-known/takosumi`,
    `${origin}/api/v1/capabilities`,
  ]);
}

test("server runtime Store configuration reaches dashboard discovery without a rebuild", async () => {
  try {
    await loadFromServer(" https://store.operator.example/public/ ");
    expect(runtimeStoreUrl()).toBe("https://store.operator.example/public/");
    expect(getTcsServers()[0]).toEqual({
      base: "https://store.operator.example/public",
      isDefault: true,
    });

    // A new server configuration replaces the previous runtime endpoint.
    await loadFromServer("http://localhost:26402/other");
    expect(runtimeStoreUrl()).toBe("http://localhost:26402/other");
    expect(getTcsServers()[0]?.base).toBe("http://localhost:26402/other");

    for (const endpoint of [
      "https://user:secret@store.operator.example",
      "https://store.operator.example?token=secret",
      "https://store.operator.example/#secret",
      "javascript:alert(1)",
      "/store",
      "",
      undefined,
    ]) {
      await loadFromServer(endpoint);
      expect(runtimeStoreUrl()).toBeUndefined();
    }
  } finally {
    await loadFromServer(undefined);
  }
});
