import { expect, test } from "bun:test";
import {
  handleSharedAuthAccountBoundaryRequest,
  type SharedAuthEnvironment,
} from "../../../worker/src/shared_auth_rpc.ts";

const origin = "https://app-staging.takosumi.com";
const env: SharedAuthEnvironment = {
  TAKOSUMI_SHARED_AUTH_PROFILE: "shared-account",
  TAKOSUMI_SHARED_AUTH_ORIGIN: origin,
  TAKOSUMI_ENVIRONMENT: "staging",
  HOSTED: {
    fetchSharedAuth: async () => new Response(null, { status: 204 }),
    authenticateSharedAuth: async () => ({ kind: "unauthenticated" }),
    resolveSharedAuthWorkspace: async () => ({ kind: "forbidden" }),
  },
};

test("shared sign-in forwards the installed app context to its fixed RP login", async () => {
  const destination = "/new?git=https%3A%2F%2Fgit.example.test%2Facme%2Fnotes.git&ref=v1&product=notes-app&return_uri=notesapp%3A%2F%2Fconnect";
  const response = await handleSharedAuthAccountBoundaryRequest(
    new Request(`${origin}/sign-in?${new URLSearchParams({ return: destination })}`),
    env,
  );
  expect(response?.status).toBe(302);
  expect(response?.headers.get("location")).toBe(
    `${origin}/auth/oidc/login?${new URLSearchParams({ return: destination })}`,
  );
});

test("shared sign-in canonicalizes its existing return alias for GET and HEAD", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = await handleSharedAuthAccountBoundaryRequest(
      new Request(`${origin}/sign-in?${new URLSearchParams({ return_to: "/new?name=notes#configure" })}`, { method }),
      env,
    );
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(
      `${origin}/auth/oidc/login?return=%2Fnew%3Fname%3Dnotes%23configure`,
    );
    expect(response?.headers.get("cache-control")).toBe("no-store");
  }
});

test("unsafe or oversized sign-in destinations retain the fixed login fallback", async () => {
  for (const destination of [
    "https://attacker.example.test/new", "//attacker.example.test/new",
    "/\\attacker.example.test", "/.//attacker.example.test", "javascript:alert(1)",
    "/new\r\nlocation:https://attacker.example.test", "/new\u0000", "/new\t", " /new", "/new ",
    "/" + "a".repeat(4096), "/" + "あ".repeat(1400), "/" + "あ".repeat(600), "",
  ]) {
    const response = await handleSharedAuthAccountBoundaryRequest(
      new Request(`${origin}/sign-in?${new URLSearchParams({ return: destination })}`), env,
    );
    expect(response?.status, JSON.stringify(destination)).toBe(302);
    expect(response?.headers.get("location")).toBe(`${origin}/auth/oidc/login`);
  }
});

test("shared sign-in rejects duplicate, conflicting and unknown routing fields", async () => {
  for (const query of [
    "return=%2Fnew&return=%2Fother", "return_to=%2Fnew&return_to=%2Fother",
    "return=%2Fnew&return_to=%2Fother", "returnTo=%2Fnew", "return_uri=notesapp%3A%2F%2Fconnect",
    "return=%2Fnew&provider=attacker",
  ]) {
    const response = await handleSharedAuthAccountBoundaryRequest(new Request(`${origin}/sign-in?${query}`), env);
    expect(response?.status).toBe(400);
    expect(response?.headers.get("location")).toBeNull();
  }
});

test("install return routing never opts self-host or another origin into shared login", async () => {
  const request = new Request(`${origin}/sign-in?return=%2Fnew`);
  expect(await handleSharedAuthAccountBoundaryRequest(request, {})).toBeUndefined();
  expect((await handleSharedAuthAccountBoundaryRequest(request, {
    ...env, TAKOSUMI_ENVIRONMENT: "production",
  }))?.status).toBe(503);
  expect((await handleSharedAuthAccountBoundaryRequest(
    new Request("https://alias.example.test/sign-in?return=%2Fnew"), env,
  ))?.status).toBe(404);
  expect((await handleSharedAuthAccountBoundaryRequest(new Request(`${origin}/sign-in`), env))?.headers.get("location"))
    .toBe(`${origin}/auth/oidc/login`);
});
