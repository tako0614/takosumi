import { expect, test } from "bun:test";
import worker from "../../../deploy/platform/worker.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

function platformEnv() {
  const assetRequests: string[] = [];
  return {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_RESOURCE_SHAPES: "ObjectBucket,EdgeWorker",
    TAKOSUMI_RESOURCE_ADAPTERS: "operator.legacy",
    TAKOSUMI_TAKOFORM_V1ALPHA1_COMPATIBILITY_HOST: "1",
    TAKOSUMI_RESOURCE_FORM_TRANSITION_HOST: "1",
    TAKOSUMI_RESOURCE_FORM_TRANSITION_EVIDENCE: "legacy-evidence",
    R2_FORM_PACKAGES: { get: async () => new Response("stale") },
    TAKOSUMI_FORM_PACKAGE_TRUST_POLICY: "legacy-policy",
    TAKOSUMI_FORM_PACKAGE_HOST_COMPOSITION: "legacy-composition",
    ASSETS: {
      fetch: async (request: Request) => {
        assetRequests.push(new URL(request.url).pathname);
        return new Response("dashboard", { status: 200 });
      },
    },
    assetRequests,
  } as never;
}

test(
  "platform tombstones the complete Takoform Host namespace before auth or SPA fallback",
  async () => {
    const paths = [
      "/.well-known/takoform",
      "/.well-known/takoform/v1alpha1",
      "/.well-known/takoform/v1alpha2",
      "/.well-known/takoform/v1alpha3",
      "/apis/forms.takoform.com",
      "/apis/forms.takoform.com/v1",
      "/apis/forms.takoform.com/v1beta1",
      "/apis/forms.takoform.com/v1beta1/future-resource",
      "/apis/forms.takoform.com/v2beta99/future-resource",
      "/apis/forms.takoform.com/v1alpha1/forms",
      "/apis/forms.takoform.com/v1alpha1/form-definitions/ObjectBucket",
      "/apis/forms.takoform.com/v1alpha1/interfaces",
      "/apis/forms.takoform.com/v1alpha1/resources/ObjectBucket/assets",
      "/apis/forms.takoform.com/v1alpha1/resources/ObjectBucket/assets/preview",
      "/apis/forms.takoform.com/v1alpha1/resources/ObjectBucket/assets/observe",
      "/apis/forms.takoform.com/v1alpha1/resources/ObjectBucket/assets/form-transitions",
      "/apis/forms.takoform.com/v1alpha2/resources/ObjectBucket/assets",
      "/apis/forms.takoform.com/v1alpha3/resources/ObjectBucket/assets",
      "/v1",
      "/v1/resources/ObjectBucket/example",
      "/v1/interfaces",
      "/internal/v1/form-packages/install",
      "/internal/v1/form-packages/reverify",
    ];

    for (const path of paths) {
      const env = platformEnv();
      for (const authorization of [
        undefined,
        "Bearer resource-token",
        "Bearer stale",
      ]) {
        const headers = authorization ? { authorization } : undefined;
        const response = await worker.fetch(
          new Request(
            `https://app.takosumi.test${path}`,
            headers ? { headers } : undefined,
          ),
          env,
        );
        expect(response.status).toBe(404);
      }
      expect(env.assetRequests).toEqual([]);
    }
  },
);

test("platform keeps the canonical Interface API outside the retired Host namespace", async () => {
  const env = platformEnv();
  const { assetRequests } = env;
  const response = await worker.fetch(
    new Request("https://app.takosumi.test/api/v1/interfaces"),
    env,
  );
  expect(response.status).toBe(401);
  expect(response.headers.get("content-type")).toMatch(/application\/json/u);
  expect(assetRequests).toEqual([]);
});
