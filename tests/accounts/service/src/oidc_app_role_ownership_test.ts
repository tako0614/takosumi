import { expect, test } from "bun:test";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { signEs256Jwt } from "../../../../accounts/service/src/jwt.ts";
import { oidcClientActivationDigest } from "../../../../accounts/service/src/oidc-activation.ts";
import { handleAuthorize, handleToken, handleUserInfo } from "../../../../accounts/service/src/oidc-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { createInMemoryInterfaceStores } from "../../../../core/domains/interfaces/mod.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const OWNER = "tsub_oidc_owner";
const NEXT_OWNER = "tsub_oidc_next_owner";
const MEMBER = "tsub_oidc_member";
const CAPSULE = "cap_oidc_ownership";
const CLIENT = "toc_oidc_ownership";
const ISSUER = "https://accounts.example.test";
const REDIRECT = "https://app.example.test/auth/callback";

async function fixture(subject = OWNER) {
  const ledger = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(ledger, { capsuleId: CAPSULE, installConfig: {
    variableMapping: { application_url: "https://app.example.test", oidc_client_id: CLIENT },
    installExperience: { projections: [{ kind: "oidc_client", variables: { clientId: "oidc_client_id" },
      callbackPath: "/auth/callback", scopes: ["openid", "profile", "offline_access"] }] },
  } });
  await ledger.putCapsule({ ...seeded.capsule, status: "active" });
  await ledger.putWorkspace({ ...seeded.workspace, ownerUserId: OWNER });
  const { operations: core } = await createTakosumiService({ role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" }, opentofuControlStore: ledger,
    interfaceStores: createInMemoryInterfaceStores({ workspaceManagementAuthority: ledger }),
  });
  expect(await core.appOwnership.initializeOwnershipIfMissing({ capsuleId: CAPSULE,
    ownerAccountId: OWNER, ownershipEpoch: 0, managementState: "active", managementEpoch: 0,
    storageRoot: `apps/${CAPSULE}` })).toBe(true);
  await core.appOwnership.putMember({ capsuleId: CAPSULE, accountId: MEMBER, status: "active",
    addedBy: OWNER, createdAt: seeded.capsule.createdAt, updatedAt: seeded.capsule.updatedAt });
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAccount({ subject, createdAt: now, updatedAt: now });
  store.saveAccountSession({ sessionId: "sess_oidc_ownership", subject,
    createdAt: now, expiresAt: now + 60_000 });
  store.saveOidcClient({ clientId: CLIENT, capsuleId: CAPSULE, namespacePath: "identity.oidc",
    issuerUrl: ISSUER, redirectUris: [REDIRECT], allowedScopes: ["openid", "profile", "offline_access"],
    subjectMode: "pairwise", tokenEndpointAuthMethod: "none", createdAt: now, updatedAt: now,
    activationDigest: await oidcClientActivationDigest({ scopeRef: seeded.workspace.id, capsuleId: CAPSULE,
      executionAuthorityEpoch: await core.capsules.getCapsuleExecutionAuthorityEpoch(CAPSULE),
      installConfig: seeded.installConfig }),
  });
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const flow = { subject: "unused", pairwiseSubjectSecret: "synthetic-pairwise-secret",
    issueIdToken: (claims: Record<string, unknown>) => signEs256Jwt({
      header: { alg: "ES256", typ: "JWT", kid: "synthetic-key" }, claims, privateKey: keys.privateKey,
    }),
  };
  let onWorkspaceRead: (() => Promise<void>) | undefined;
  const operations = { ...core, workspaces: { ...core.workspaces,
    getWorkspace: async (id: string) => {
      const action = onWorkspaceRead;
      onWorkspaceRead = undefined;
      await action?.();
      return core.workspaces.getWorkspace(id);
    },
  } } as unknown as ControlPlaneOperations;
  async function token(form: Record<string, string>) {
    const response = await handleToken({ issuer: ISSUER, store, flow, clients: new Map(), operations,
      request: new Request(`${ISSUER}/oauth/token`, { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: CLIENT, ...form }),
      }),
    });
    expect(response.status).toBe(200);
    return await response.json() as { id_token: string; access_token: string; refresh_token: string };
  }
  async function authorize() {
    const verifier = "synthetic-ownership-code-verifier";
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    const url = new URL(`${ISSUER}/oauth/authorize`);
    url.search = new URLSearchParams({ response_type: "code", client_id: CLIENT, redirect_uri: REDIRECT,
      scope: "openid profile offline_access", code_challenge: challenge, code_challenge_method: "S256" }).toString();
    const response = await handleAuthorize({ url, store, flow, clients: new Map(), operations,
      request: new Request(url, { headers: { "x-takosumi-account-session": "sess_oidc_ownership" } }),
    });
    expect(response.status).toBe(302);
    return { grant_type: "authorization_code", code: new URL(response.headers.get("location")!).searchParams.get("code")!,
      redirect_uri: REDIRECT, code_verifier: verifier };
  }
  async function claims(jwt: string) {
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString()).alg).toBe("ES256");
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, keys.publicKey,
      Buffer.from(signature!, "base64url"), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
    return JSON.parse(Buffer.from(payload!, "base64url").toString()) as { takosumi: Record<string, unknown> };
  }
  async function transfer(ownerAccountId = NEXT_OWNER) {
    const ownership = (await core.appOwnership.getOwnership(CAPSULE))!;
    expect(await core.appOwnership.putOwnership({ ...ownership, ownerAccountId,
      ownershipEpoch: ownership.ownershipEpoch + 1 }, ownership.ownershipEpoch)).toBe(true);
  }
  function transferDuringWorkspaceRead(roundTrip = false) {
    // The real resolver has already read owner/epoch when this later await is reached.
    onWorkspaceRead = async () => {
      await transfer();
      if (roundTrip) await transfer(OWNER);
    };
  }
  return { core, store, operations, token, authorize, claims, transfer, transferDuringWorkspaceRead };
}

for (const [subject, role] of [[OWNER, "owner"], [MEMBER, "member"], ["tsub_oidc_ordinary_user", undefined]] as const) {
  test(`signed app token carries only the current management role for ${subject}`, async () => {
    const h = await fixture(subject);
    const issued = await h.token(await h.authorize());
    const { takosumi } = await h.claims(issued.id_token);
    expect(takosumi.capsule_id).toBe(CAPSULE);
    expect(takosumi.app_role).toBe(role);
  });
}

test("a new owner receives the owner claim from the current ownership generation", async () => {
  const h = await fixture(NEXT_OWNER);
  await h.transfer();
  const { takosumi } = await h.claims((await h.token(await h.authorize())).id_token);
  expect(takosumi).toEqual({ capsule_id: CAPSULE, app_role: "owner" });
});

test("returning ownership to the same account still invalidates its earlier access generation", async () => {
  const h = await fixture();
  const code = await h.authorize();
  h.transferDuringWorkspaceRead(true);
  const { takosumi } = await h.claims((await h.token(code)).id_token);
  expect((await h.core.appOwnership.getOwnership(CAPSULE))?.ownershipEpoch).toBe(2);
  expect(takosumi).toEqual({ capsule_id: CAPSULE });
});

for (const boundary of ["code", "refresh", "userinfo"] as const) {
  test(`${boundary} omits the previous owner's management claims when ownership changes after access resolution`, async () => {
    const h = await fixture();
    const code = await h.authorize();
    const initial = boundary === "code" ? undefined : await h.token(code);
    h.transferDuringWorkspaceRead();
    let takosumi: Record<string, unknown>;
    if (boundary === "userinfo") {
      const response = await handleUserInfo({ store: h.store, operations: h.operations, clients: new Map(),
        request: new Request(`${ISSUER}/oauth/userinfo`, { headers: { authorization: `Bearer ${initial!.access_token}` } }),
      });
      expect(response.status).toBe(200);
      ({ takosumi } = await response.json() as { takosumi: Record<string, unknown> });
    } else {
      const issued = await h.token(boundary === "code" ? code
        : { grant_type: "refresh_token", refresh_token: initial!.refresh_token });
      ({ takosumi } = await h.claims(issued.id_token));
    }
    expect((await h.core.appOwnership.getOwnership(CAPSULE))?.ownerAccountId).toBe(NEXT_OWNER);
    expect(takosumi).toEqual({ capsule_id: CAPSULE });
  });
}
