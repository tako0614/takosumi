import { expect, test } from "bun:test";
import {
  TAKOFORM_FORM_HOST_API_PATH,
  TAKOFORM_FORM_HOST_WELL_KNOWN_PATH,
} from "../../../contract/form-host-interoperability.ts";
import worker, {
  handlePlatformResourceShapeApiRequest,
} from "../../../deploy/platform/worker.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

function platformEnv() {
  return {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_RESOURCE_SHAPES: "ObjectBucket",
  } as never;
}

test("platform serves the portable Form host through the canonical Core handler", async () => {
  const assetRequests: string[] = [];
  const env = {
    ...platformEnv(),
    ASSETS: {
      fetch: async (request: Request) => {
        assetRequests.push(new URL(request.url).pathname);
        return new Response("<html>dashboard fallback</html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  } as never;

  const discovery = await worker.fetch(
    new Request(
      `https://app.takosumi.test${TAKOFORM_FORM_HOST_WELL_KNOWN_PATH}`,
    ),
    env,
  );
  expect(discovery.status).toBe(200);
  expect(discovery.headers.get("content-type")).toContain("application/json");

  const forms = await worker.fetch(
    new Request(
      `https://app.takosumi.test${TAKOFORM_FORM_HOST_API_PATH}/forms?space=workspace_a`,
      { headers: { authorization: "Bearer resource-token" } },
    ),
    env,
  );
  expect(forms.status).toBe(200);
  expect(forms.headers.get("content-type")).toContain("application/json");
  expect(assetRequests).toEqual([]);
});

test("platform rejects portable Form selectors outside the verified Workspace", async () => {
  const env = platformEnv();
  const verifyWorkspaceA = async () => ({
    authenticated: true as const,
    authKind: "personal-access-token" as const,
    subject: "account_a",
    workspaceId: "workspace_a",
    scopes: ["admin"],
  });

  const crossWorkspaceForms = await handlePlatformResourceShapeApiRequest(
    new Request(
      `https://app.takosumi.test${TAKOFORM_FORM_HOST_API_PATH}/forms?space=workspace_b`,
    ),
    env,
    verifyWorkspaceA,
  );
  expect(crossWorkspaceForms.status).toBe(403);

  const crossWorkspacePreview = await handlePlatformResourceShapeApiRequest(
    new Request(
      `https://app.takosumi.test${TAKOFORM_FORM_HOST_API_PATH}/resources/preview`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiVersion: "forms.takoform.com/v1alpha1",
          kind: "ObjectBucket",
          form: {
            formRef: {
              apiVersion: "forms.takoform.com/v1alpha1",
              kind: "ObjectBucket",
              definitionVersion: "0.0.0-legacy.1",
              schemaDigest: `sha256:${"1".repeat(64)}`,
            },
            packageDigest: `sha256:${"2".repeat(64)}`,
          },
          metadata: { space: "workspace_b", name: "private-assets" },
          spec: { name: "private-assets" },
        }),
      },
    ),
    env,
    verifyWorkspaceA,
  );
  expect(crossWorkspacePreview.status).toBe(403);
});
