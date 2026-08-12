import { expect, test } from "bun:test";
import worker from "../../../deploy/platform/worker.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const TOKEN = "process-route-token";

function platformEnv(options: { readonly token?: string } = {}) {
  const assetRequests: string[] = [];
  const token = Object.hasOwn(options, "token") ? options.token : TOKEN;
  return {
    env: {
      TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_ENVIRONMENT: "test",
      ...(token === undefined ? {} : { TAKOSUMI_DEPLOY_CONTROL_TOKEN: token }),
      ASSETS: {
        fetch: async (request: Request) => {
          assetRequests.push(new URL(request.url).pathname);
          return new Response("<html>dashboard fallback</html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
      },
    } as never,
    assetRequests,
  };
}

for (const method of ["GET", "HEAD"] as const) {
  test(`platform dispatches exact Core process routes for ${method}`, async () => {
    const { env, assetRequests } = platformEnv();
    for (const path of ["/livez", "/capabilities", "/openapi.json"]) {
      const response = await worker.fetch(
        new Request(`https://app.takosumi.test${path}`, {
          method,
          ...(path === "/capabilities" || path === "/openapi.json"
            ? { headers: { authorization: `Bearer ${TOKEN}` } }
            : {}),
        }),
        env,
      );
      expect(response.status, `${method} ${path}`).toBe(200);
      expect(response.headers.get("content-type"), `${method} ${path}`).toMatch(
        /application\/json/u,
      );
    }
    expect(assetRequests).toEqual([]);
  });
}

test("platform preserves Core inventory bearer semantics", async () => {
  for (const path of ["/capabilities", "/openapi.json"]) {
    const wrong = platformEnv();
    const wrongResponse = await worker.fetch(
      new Request(`https://app.takosumi.test${path}`, {
        headers: { authorization: "Bearer wrong-token" },
      }),
      wrong.env,
    );
    expect(wrongResponse.status, path).toBe(401);
    expect(wrong.assetRequests).toEqual([]);

    const unconfigured = platformEnv({ token: undefined });
    const unconfiguredResponse = await worker.fetch(
      new Request(`https://app.takosumi.test${path}`),
      unconfigured.env,
    );
    expect(unconfiguredResponse.status, path).toBe(404);
    expect(unconfigured.assetRequests).toEqual([]);
  }
});

test("platform leaves trailing process paths to the explicit SPA fallback", async () => {
  const { env, assetRequests } = platformEnv();
  for (const path of ["/livez/", "/capabilities/", "/openapi.json/"]) {
    const response = await worker.fetch(
      new Request(`https://app.takosumi.test${path}`),
      env,
    );
    expect(response.status, path).toBe(200);
    expect(response.headers.get("content-type"), path).toMatch(/text\/html/u);
  }
  expect(assetRequests).toEqual(["/livez/", "/capabilities/", "/openapi.json/"]);
});

test("platform reserves unknown webhook paths outside the SPA fallback", async () => {
  const { env, assetRequests } = platformEnv();
  for (const path of ["/hooks", "/hooks/unknown"]) {
    const response = await worker.fetch(
      new Request(`https://app.takosumi.test${path}`),
      env,
    );
    expect(response.status, path).toBe(404);
    expect(response.headers.get("content-type"), path).toMatch(
      /application\/json/u,
    );
    expect(await response.json(), path).toEqual({ error: "not found" });
  }
  expect(assetRequests).toEqual([]);
});
