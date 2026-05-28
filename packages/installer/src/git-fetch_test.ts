import assert from "node:assert/strict";
import { fetchGitSource } from "./git-fetch.ts";

// These tests exercise URL validation only — they intentionally never reach
// the `git clone` call because `assertAllowedGitUrl` rejects the bad inputs
// before any subprocess work happens.

Deno.test("fetchGitSource rejects SSH shorthand to bracketed IPv6 loopback", async () => {
  await assert.rejects(
    fetchGitSource({ url: "git@[::1]:owner/repo.git" }),
    /git source host is not allowed/,
  );
});

Deno.test("fetchGitSource rejects SSH shorthand to bracketed IPv6 link-local", async () => {
  await assert.rejects(
    fetchGitSource({ url: "git@[fe80::1]:owner/repo.git" }),
    /git source host is not allowed/,
  );
});

Deno.test("fetchGitSource rejects IPv6 mapped IPv4 loopback (dotted form)", async () => {
  await assert.rejects(
    fetchGitSource({ url: "https://[::ffff:127.0.0.1]/owner/repo.git" }),
    /git source host is not allowed/,
  );
});

Deno.test("fetchGitSource rejects IPv6 mapped IPv4 loopback (hex form)", async () => {
  // ::ffff:7f00:1 == ::ffff:127.0.0.1 — a previous bypass attempt
  // hidden in the canonical hex compression of the IPv4 octets.
  await assert.rejects(
    fetchGitSource({ url: "https://[::ffff:7f00:1]/owner/repo.git" }),
    /git source host is not allowed/,
  );
});

Deno.test("fetchGitSource rejects IPv6 mapped IPv4 metadata (hex form)", async () => {
  // ::ffff:a9fe:a9fe == ::ffff:169.254.169.254 (AWS / GCP metadata service).
  await assert.rejects(
    fetchGitSource({ url: "https://[::ffff:a9fe:a9fe]/owner/repo.git" }),
    /git source host is not allowed/,
  );
});

Deno.test("fetchGitSource rejects deprecated IPv4-compatible IPv6 form", async () => {
  // ::127.0.0.1 — deprecated IPv4-compatible IPv6 address form.
  await assert.rejects(
    fetchGitSource({ url: "https://[::127.0.0.1]/owner/repo.git" }),
    /git source host is not allowed/,
  );
});

Deno.test("fetchGitSource rejects SSH shorthand with unmatched IPv6 bracket", async () => {
  await assert.rejects(
    fetchGitSource({ url: "git@[::1:owner/repo.git" }),
    /unmatched IPv6 bracket/,
  );
});

Deno.test("fetchGitSource rejects IPv6 unique-local literal", async () => {
  await assert.rejects(
    fetchGitSource({ url: "https://[fd00::1]/owner/repo.git" }),
    /git source host is not allowed/,
  );
});

Deno.test("fetchGitSource rejects IPv4 loopback (HTTPS)", async () => {
  await assert.rejects(
    fetchGitSource({ url: "https://127.0.0.1/owner/repo.git" }),
    /git source host is not allowed/,
  );
});

Deno.test("fetchGitSource rejects IPv4 metadata service (SSH shorthand)", async () => {
  await assert.rejects(
    fetchGitSource({ url: "git@169.254.169.254:owner/repo.git" }),
    /git source host is not allowed/,
  );
});

Deno.test("fetchGitSource rejects file:// scheme", async () => {
  await assert.rejects(
    fetchGitSource({ url: "file:///etc/passwd" }),
    /scheme is not allowed/,
  );
});

Deno.test("fetchGitSource rejects argument that starts with '-'", async () => {
  await assert.rejects(
    fetchGitSource({ url: "--upload-pack=evil" }),
    /must not start with '-'/,
  );
});

Deno.test("fetchGitSource rejects ref containing newline", async () => {
  await assert.rejects(
    fetchGitSource({
      url: "https://example.test/owner/repo.git",
      ref: "main\n--exec=evil",
    }),
    /must not contain control characters/,
  );
});
