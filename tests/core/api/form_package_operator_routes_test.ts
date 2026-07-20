import { expect, test } from "bun:test";
import type {
  FormPackageArtifactReader,
  FormPackageVerifier,
} from "../../../core/domains/service-forms/mod.ts";
import { InMemoryFormRegistryStore } from "../../../core/domains/service-forms/mod.ts";
import { createTakosumiService } from "../../../core/bootstrap.ts";

const TOKEN = "operator-form-package-token";
const PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const SCHEMA_DIGEST = `sha256:${"b".repeat(64)}`;
const FORM_REF = {
  apiVersion: "forms.takoform.com/v1alpha1",
  kind: "ObjectBucket",
  definitionVersion: "1.0.0",
  schemaDigest: SCHEMA_DIGEST,
} as const;
const IDENTITY = { formRef: FORM_REF, packageDigest: PACKAGE_DIGEST } as const;
const HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
} as const;

class Reader implements FormPackageArtifactReader {
  readonly refs: string[] = [];

  async read(artifactRef: string): Promise<Uint8Array> {
    this.refs.push(artifactRef);
    return new TextEncoder().encode("signed-data-only-package");
  }
}

class Verifier implements FormPackageVerifier {
  readonly id = "test.sigstore.v1";
  readonly digests: string[] = [];

  async verify(_bytes: Uint8Array, expectedPackageDigest: string) {
    this.digests.push(expectedPackageDigest);
    return {
      packageDigest: expectedPackageDigest,
      definitions: [
        {
          formRef: FORM_REF,
          operations: ["create", "read", "delete"] as const,
        },
      ],
    };
  }
}

async function fixture(
  options: {
    readonly workspaceIds?: readonly string[] | "*";
    readonly reader?: FormPackageArtifactReader;
    readonly verifier?: FormPackageVerifier;
    readonly withRegistry?: boolean;
  } = {},
) {
  const reader = options.reader ?? new Reader();
  const verifier = options.verifier ?? new Verifier();
  const withRegistry = options.withRegistry ?? true;
  const created = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_ENVIRONMENT: "test",
      TAKOSUMI_DEV_MODE: "1",
    },
    ...(withRegistry
      ? {
          formRegistryStore: new InMemoryFormRegistryStore(),
          formPackageArtifactReader: reader,
          formPackageVerifier: verifier,
        }
      : {}),
    authorizeDeployControlBearer: ({ token }) =>
      token === TOKEN
        ? {
            actor: "acct_operator",
            workspaceIds: options.workspaceIds ?? "*",
            operations: "*",
            runnerProfileIds: "*",
          }
        : undefined,
  });
  return { ...created, reader, verifier };
}

test("operator route installs and re-verifies through the composed trusted registry", async () => {
  const { app, reader, verifier } = await fixture();
  const artifactRef = "r2:packages/object-bucket-v1.tgz";
  const installed = await app.request("/internal/v1/form-packages/install", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      artifactRef,
      expectedPackageDigest: PACKAGE_DIGEST,
    }),
  });
  expect(installed.status).toBe(200);
  const installedBody = await installed.json();
  expect(installedBody).toMatchObject({
    verified: true,
    packageDigest: PACKAGE_DIGEST,
    verifierId: "test.sigstore.v1",
    definitionRefs: [FORM_REF],
  });
  expect(JSON.stringify(installedBody)).not.toContain(artifactRef);
  expect(JSON.stringify(installedBody)).not.toContain("acct_operator");

  const reverified = await app.request("/internal/v1/form-packages/reverify", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(IDENTITY),
  });
  expect(reverified.status).toBe(200);
  const reverifiedBody = await reverified.json();
  expect(reverifiedBody).toMatchObject({
    verified: true,
    identity: IDENTITY,
    packageDigest: PACKAGE_DIGEST,
  });
  expect(JSON.stringify(reverifiedBody)).not.toContain(artifactRef);
  expect((reader as Reader).refs).toEqual([artifactRef, artifactRef]);
  expect((verifier as Verifier).digests).toEqual([
    PACKAGE_DIGEST,
    PACKAGE_DIGEST,
  ]);
});

test("Form Package routes reject scoped callers and caller-selected actors", async () => {
  const { app, reader } = await fixture({ workspaceIds: ["ws_customer1"] });
  const denied = await app.request("/internal/v1/form-packages/install", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      artifactRef: "r2:packages/object-bucket-v1.tgz",
      expectedPackageDigest: PACKAGE_DIGEST,
    }),
  });
  expect(denied.status).toBe(403);
  expect((reader as Reader).refs).toEqual([]);

  const operator = await fixture();
  const actorInjection = await operator.app.request(
    "/internal/v1/form-packages/install",
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        artifactRef: "r2:packages/object-bucket-v1.tgz",
        expectedPackageDigest: PACKAGE_DIGEST,
        actorId: "acct_attacker",
      }),
    },
  );
  expect(actorInjection.status).toBe(400);
  expect((operator.reader as Reader).refs).toEqual([]);
});

test("Form Package routes fail closed when the registry or trust contribution is unavailable", async () => {
  const absent = await fixture({ withRegistry: false });
  const noRegistry = await absent.app.request(
    "/internal/v1/form-packages/install",
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        artifactRef: "r2:packages/object-bucket-v1.tgz",
        expectedPackageDigest: PACKAGE_DIGEST,
      }),
    },
  );
  expect(noRegistry.status).toBe(501);

  const noTrust = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_ENVIRONMENT: "test",
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
    formRegistryStore: new InMemoryFormRegistryStore(),
  });
  const unavailable = await noTrust.app.request(
    "/internal/v1/form-packages/install",
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        artifactRef: "r2:packages/object-bucket-v1.tgz",
        expectedPackageDigest: PACKAGE_DIGEST,
      }),
    },
  );
  expect(unavailable.status).toBe(409);
  expect(await unavailable.json()).toMatchObject({
    error: {
      code: "failed_precondition",
      details: { reason: "form_package_verification_unavailable" },
    },
  });
});

test("reader and verifier failures never expose artifact or package-derived details", async () => {
  const secret = "DO-NOT-LEAK-PRIVATE-R2-LOCATION";
  const reader: FormPackageArtifactReader = {
    async read() {
      throw new Error(secret);
    },
  };
  const request = {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      artifactRef: `r2:packages/${secret}`,
      expectedPackageDigest: PACKAGE_DIGEST,
    }),
  } as const;
  const readerFailure = await fixture({ reader });
  const readerResponse = await readerFailure.app.request(
    "/internal/v1/form-packages/install",
    request,
  );
  expect(readerResponse.status).toBe(500);
  const readerText = await readerResponse.text();
  expect(readerText).not.toContain(secret);
  expect(JSON.parse(readerText)).toMatchObject({
    error: {
      code: "internal_error",
      message: "Form Package operation failed",
      details: { reason: "form_package_internal_error" },
    },
  });

  const verifier: FormPackageVerifier = {
    id: "test.failure.v1",
    async verify() {
      throw new Error(secret);
    },
  };
  const verifierFailure = await fixture({ verifier });
  const verifierResponse = await verifierFailure.app.request(
    "/internal/v1/form-packages/install",
    request,
  );
  expect(verifierResponse.status).toBe(409);
  const verifierText = await verifierResponse.text();
  expect(verifierText).not.toContain(secret);
  expect(JSON.parse(verifierText)).toMatchObject({
    error: {
      code: "failed_precondition",
      message: "Form Package verification failed",
      details: { reason: "form_package_verification_failed" },
    },
  });
});
