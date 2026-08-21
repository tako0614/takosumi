import { expect, test } from "bun:test";
import {
  TAKOFORM_FORM_HOST_API_PATH,
  TAKOFORM_FORM_HOST_WELL_KNOWN_PATH,
} from "../../../contract/form-host-interoperability.ts";
import { createRunCredentialToken } from "../../../core/shared/run_credential_tokens.ts";
import worker, {
  handlePlatformResourceShapeApiRequest,
  handlePlatformTakoformV1alpha1CompatibilityRequest,
  isPlatformResourceFormTransitionRequest,
  isPlatformTakoformV1alpha1CompatibilityRequest,
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

const RUN_SECRET = "portable-form-host-run-secret-32-bytes-minimum";

function compatibilityEnv() {
  return {
    ...platformEnv(),
    TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET: RUN_SECRET,
    TAKOSUMI_TAKOFORM_V1ALPHA1_COMPATIBILITY_HOST: {
      apiVersion: "forms.takoform.com/v1alpha1",
      mode: "frozen-maintenance",
    },
    TAKOSUMI_RESOURCE_FORM_TRANSITION_HOST: {
      dispatch: async () => {
        throw new Error("transition host must not be reached by route test");
      },
      readback: async () => ({ status: "absent" as const }),
    },
    TAKOSUMI_RESOURCE_FORM_TRANSITION_EVIDENCE: {
      authorize: async () => false,
    },
  } as never;
}

test("platform keeps the retired portable Form host ahead of the SPA fallback", async () => {
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
  expect(discovery.status).toBe(404);

  const forms = await worker.fetch(
    new Request(
      `https://app.takosumi.test${TAKOFORM_FORM_HOST_API_PATH}/forms?space=workspace_a`,
      { headers: { authorization: "Bearer resource-token" } },
    ),
    env,
  );
  expect(forms.status).toBe(404);
  expect(assetRequests).toEqual([]);

  const weakCredentialEnv = {
    ...compatibilityEnv(),
    TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET: "weak",
  } as never;
  const weakDiscovery = await worker.fetch(
    new Request(
      `https://app.takosumi.test${TAKOFORM_FORM_HOST_WELL_KNOWN_PATH}`,
    ),
    weakCredentialEnv,
  );
  expect(weakDiscovery.status).toBe(404);
});

test("platform mounts one coherent frozen v1alpha1 host only from code-owned composition", async () => {
  const env = compatibilityEnv();
  const discovery = await worker.fetch(
    new Request(
      `https://app.takosumi.test${TAKOFORM_FORM_HOST_WELL_KNOWN_PATH}`,
    ),
    env,
  );
  expect(discovery.status).toBe(200);
  expect(await discovery.json()).toMatchObject({
    api_versions: ["forms.takoform.com/v1alpha1"],
    features: {
      service_forms: true,
      resource_form_transition: true,
    },
    endpoints: {
      api: `https://app.takosumi.test${TAKOFORM_FORM_HOST_API_PATH}`,
      forms: `https://app.takosumi.test${TAKOFORM_FORM_HOST_API_PATH}/forms`,
    },
  });

  const issued = await createRunCredentialToken({
    secret: RUN_SECRET,
    audience: "current-recipe-audience",
    subject: "principal_installer",
    workspaceId: "workspace_a",
    capsuleId: "capsule_a",
    runId: "apply_a",
    installingPrincipalId: "principal_installer",
    connectionId: "connection_a",
    provider: "registry.opentofu.org/tako0614/takoform",
    phase: "apply",
    scopes: ["takoform.host.invoke"],
    now: () => new Date("2026-08-13T00:00:00.000Z"),
    jti: "portable-form-route-test",
  });
  const phases: string[][] = [];
  const forms = await handlePlatformTakoformV1alpha1CompatibilityRequest(
    new Request(
      `https://app.takosumi.test${TAKOFORM_FORM_HOST_API_PATH}/forms?` +
        new URLSearchParams({
          space: "workspace_a",
          apiVersion: "forms.takoform.com/v1alpha1",
          kind: "RelationalDatabase",
          definitionVersion: "2.0.0",
          schemaDigest: `sha256:${"1".repeat(64)}`,
          packageDigest: `sha256:${"2".repeat(64)}`,
        }),
      { headers: { authorization: `Bearer ${issued.token}` } },
    ),
    env,
    undefined,
    async (_env, _token, allowedPhases) => {
      phases.push([...allowedPhases]);
      return {
        authenticated: true,
        authKind: "run-credential",
        subject: "principal_installer",
        workspaceId: "workspace_a",
        capsuleId: "capsule_a",
        runId: "apply_a",
        installingPrincipalId: "principal_installer",
        phase: "apply",
        audience: "current-recipe-audience",
        scopes: ["takoform.host.invoke"],
      };
    },
  );
  expect(forms.status).toBe(200);
  expect(await forms.json()).toMatchObject({
    forms: [
      {
        identity: {
          formRef: {
            apiVersion: "forms.takoform.com/v1alpha1",
            kind: "RelationalDatabase",
            definitionVersion: "2.0.0",
          },
        },
        installed: false,
        executable: false,
      },
    ],
  });
  expect(phases).toEqual([["apply"]]);
});

test("platform recognizes only exact v1alpha1 transition POST/readback methods", () => {
  const base =
    `https://app.takosumi.test${TAKOFORM_FORM_HOST_API_PATH}` +
    "/resources/RelationalDatabase/database/form-transitions";
  expect(
    isPlatformResourceFormTransitionRequest(
      new Request(`${base}?space=workspace_a`, { method: "POST" }),
    ),
  ).toBe(true);
  expect(
    isPlatformResourceFormTransitionRequest(
      new Request(`${base}/formtx_${"1".repeat(64)}?space=workspace_a`),
    ),
  ).toBe(true);
  for (const request of [
    new Request(`${base}?space=workspace_a`),
    new Request(`${base}/formtx_${"1".repeat(64)}?space=workspace_a`, {
      method: "POST",
    }),
    new Request(
      `https://app.takosumi.test${TAKOFORM_FORM_HOST_API_PATH}/resources/RelationalDatabase/database`,
      { method: "PUT" },
    ),
    new Request(
      `https://app.takosumi.test${TAKOFORM_FORM_HOST_API_PATH}/resources/RelationalDatabase/database/form-transitions/extra/path`,
    ),
  ]) {
    expect(isPlatformResourceFormTransitionRequest(request)).toBe(false);
  }
});

test("frozen compatibility matcher is the provider's closed lifecycle set", () => {
  const api = `https://app.takosumi.test${TAKOFORM_FORM_HOST_API_PATH}`;
  const exactResource = `${api}/resources/RelationalDatabase/database`;
  for (const request of [
    new Request(`https://app.takosumi.test${TAKOFORM_FORM_HOST_WELL_KNOWN_PATH}`),
    new Request(`${api}/forms?space=workspace_a`),
    new Request(`${api}/resources/preview`, { method: "POST" }),
    new Request(`${exactResource}?space=workspace_a`),
    new Request(`${exactResource}/observe?space=workspace_a`, { method: "POST" }),
    new Request(exactResource, { method: "PUT" }),
    new Request(`${exactResource}?space=workspace_a`, { method: "DELETE" }),
    new Request(`${exactResource}/form-transitions?space=workspace_a`, {
      method: "POST",
    }),
    new Request(
      `${exactResource}/form-transitions/formtx_${"1".repeat(64)}?space=workspace_a`,
    ),
  ]) {
    expect(isPlatformTakoformV1alpha1CompatibilityRequest(request)).toBe(true);
  }

  for (const request of [
    new Request(
      `https://app.takosumi.test${TAKOFORM_FORM_HOST_WELL_KNOWN_PATH}?widen=true`,
    ),
    new Request(`${api}/resources`, { method: "GET" }),
    new Request(`${exactResource}/refresh?space=workspace_a`, { method: "POST" }),
    new Request(`${exactResource}/import`, { method: "POST" }),
    new Request(`${exactResource}/observe?space=workspace_a`, { method: "PUT" }),
    new Request(`${exactResource}/form-transitions/not-an-operation?space=workspace_a`),
  ]) {
    expect(isPlatformTakoformV1alpha1CompatibilityRequest(request)).toBe(false);
  }
});

test("platform retired portable Form selectors never reach Workspace auth", async () => {
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
  expect(crossWorkspaceForms.status).toBe(404);

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
  expect(crossWorkspacePreview.status).toBe(404);
});
