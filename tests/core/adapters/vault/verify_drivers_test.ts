import { expect, test } from "bun:test";

import type { ProviderConnection } from "takosumi-contract/connections";
import {
  verifyDriverForKind,
  verifyGitHttps,
  verifyGitSsh,
  type VerifyFetch,
} from "../../../../core/adapters/vault/verify_drivers.ts";

function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: "conn_x",
    provider: "git",
    scope: "workspace",
    workspaceId: "workspace_1",
    authMethod: "static_secret",
    status: "pending",
    envNames: [],
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    ...overrides,
  };
}

const noFetch: VerifyFetch = () => {
  throw new Error("fetch must not be called");
};

function statusFetch(status: number): {
  readonly fetch: VerifyFetch;
  readonly calls: { url: string }[];
} {
  const calls: { url: string }[] = [];
  const fetch: VerifyFetch = (url) => {
    calls.push({ url });
    return Promise.resolve(new Response("", { status }));
  };
  return { fetch, calls };
}

// --- git_https ------------------------------------------------------------

test("git_https: live smart-http probe 200 ⇒ verified", async () => {
  const { fetch, calls } = statusFetch(200);
  const result = await verifyGitHttps({
    connection: connection({
      kind: "source_git_https_token",
      scopeHints: {
        providerSettings: {
          repositoryUrl: "https://git.example.com/o/r.git",
        },
      },
    }),
    values: { GIT_HTTPS_TOKEN: "ghp_token" },
    fetch,
  });
  expect(result.ok).toBe(true);
  expect(calls[0]?.url).toBe(
    "https://git.example.com/o/r.git/info/refs?service=git-upload-pack",
  );
});

test("git_https: live smart-http probe 401 ⇒ pending bad credential", async () => {
  const { fetch } = statusFetch(401);
  const result = await verifyGitHttps({
    connection: connection({
      kind: "source_git_https_token",
      scopeHints: {
        providerSettings: {
          repositoryUrl: "https://git.example.com/o/r.git",
        },
      },
    }),
    values: { GIT_HTTPS_TOKEN: "ghp_token" },
    fetch,
  });
  expect(result.ok).toBe(false);
  expect(result.detail).toContain("bad credential");
});

test("git_https: 403 ⇒ pending bad credential", async () => {
  const { fetch } = statusFetch(403);
  const result = await verifyGitHttps({
    connection: connection({
      kind: "source_git_https_token",
      scopeHints: {
        providerSettings: {
          repositoryUrl: "https://git.example.com/o/r.git",
        },
      },
    }),
    values: { GIT_HTTPS_TOKEN: "ghp_token" },
    fetch,
  });
  expect(result.ok).toBe(false);
  expect(result.detail).toContain("bad credential");
});

test("git_https: missing token ⇒ pending (no probe)", async () => {
  const result = await verifyGitHttps({
    connection: connection({ kind: "source_git_https_token" }),
    values: {},
    fetch: noFetch,
  });
  expect(result.ok).toBe(false);
  expect(result.detail).toContain("GIT_HTTPS_TOKEN");
});

test("git_https: token present + no repoUrl ⇒ structural verified, no fetch", async () => {
  const result = await verifyGitHttps({
    connection: connection({ kind: "source_git_https_token" }),
    values: { GIT_HTTPS_TOKEN: "ghp_token" },
    fetch: noFetch,
  });
  expect(result.ok).toBe(true);
  expect(result.detail).toContain("structural verify");
});

// --- git_ssh (reserved/structural) ----------------------------------------

test("git_ssh: with known_hosts ⇒ reserved structural verified, no fetch", async () => {
  const result = await verifyGitSsh({
    connection: connection({
      kind: "source_git_ssh_key",
      scopeHints: {
        providerSettings: {
          knownHostsEntry: "git.example.com ssh-ed25519 AAAA...",
        },
      },
    }),
    values: { GIT_SSH_PRIVATE_KEY: "-----BEGIN-----" },
    fetch: noFetch,
  });
  expect(result.ok).toBe(true);
  expect(result.detail).toContain("reserved structural verify");
});

test("git_ssh: missing known_hosts ⇒ pending", async () => {
  const result = await verifyGitSsh({
    connection: connection({ kind: "source_git_ssh_key" }),
    values: { GIT_SSH_PRIVATE_KEY: "-----BEGIN-----" },
    fetch: noFetch,
  });
  expect(result.ok).toBe(false);
  expect(result.detail).toContain("known_hosts");
});

// --- registry routing -----------------------------------------------------

test("verifyDriverForKind routes only the two Git Source credential kinds", () => {
  expect(verifyDriverForKind("source_git_https_token")).toBe(verifyGitHttps);
  expect(verifyDriverForKind("source_git_ssh_key")).toBe(verifyGitSsh);
  expect(verifyDriverForKind(undefined)).toBeUndefined();
});
