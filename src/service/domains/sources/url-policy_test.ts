import { describe, expect, test } from "bun:test";
import {
  evaluateSourceUrl,
  isAllowedSourceUrl,
  type SourceUrlPolicyReason,
  type SourceUrlScheme,
} from "./url-policy.ts";

interface AllowCase {
  readonly url: string;
  readonly scheme: SourceUrlScheme;
  readonly host: string;
}

interface DenyCase {
  readonly url: string;
  readonly reason: SourceUrlPolicyReason;
}

const ALLOWED: readonly AllowCase[] = [
  { url: "https://github.com/acme/repo", scheme: "https", host: "github.com" },
  { url: "https://github.com/acme/repo.git", scheme: "https", host: "github.com" },
  { url: "https://gitlab.example.com:8443/g/r.git", scheme: "https", host: "gitlab.example.com" },
  { url: "https://Codeberg.org/Acme/Repo", scheme: "https", host: "codeberg.org" },
  { url: "ssh://git@github.com/acme/repo.git", scheme: "ssh", host: "github.com" },
  { url: "ssh://git@git.example.org:2222/acme/repo", scheme: "ssh", host: "git.example.org" },
  { url: "git@github.com:acme/repo.git", scheme: "scp", host: "github.com" },
  { url: "git@bitbucket.org:team/repo.git", scheme: "scp", host: "bitbucket.org" },
  { url: "  https://github.com/acme/repo  ", scheme: "https", host: "github.com" },
];

const DENIED: readonly DenyCase[] = [
  { url: "", reason: "empty" },
  { url: "   ", reason: "empty" },
  // file://
  { url: "file:///etc/passwd", reason: "forbidden_scheme_file" },
  { url: "FILE://host/path", reason: "forbidden_scheme_file" },
  // git://
  { url: "git://github.com/acme/repo", reason: "forbidden_scheme_git" },
  // ext::
  { url: "ext::sh -c 'id'", reason: "forbidden_scheme_ext" },
  { url: "ext::git-remote-evil", reason: "forbidden_scheme_ext" },
  // absolute path
  { url: "/srv/repos/acme.git", reason: "absolute_path" },
  { url: "/etc/passwd", reason: "absolute_path" },
  // relative path
  { url: "./local/repo", reason: "relative_path" },
  { url: "../up/repo", reason: "relative_path" },
  { url: "just-a-word", reason: "relative_path" },
  { url: "acme/repo", reason: "relative_path" },
  // embedded credentials
  { url: "https://user:pass@github.com/acme/repo", reason: "embedded_credentials" },
  { url: "https://token@github.com/acme/repo", reason: "embedded_credentials" },
  { url: "ssh://git:secret@github.com/acme/repo", reason: "embedded_credentials" },
  // other forbidden schemes
  { url: "http://github.com/acme/repo", reason: "forbidden_scheme_other" },
  { url: "ftp://host/x", reason: "forbidden_scheme_other" },
  { url: "s3://bucket/key", reason: "forbidden_scheme_other" },
];

describe("evaluateSourceUrl — allowed forms", () => {
  for (const c of ALLOWED) {
    test(`allows ${JSON.stringify(c.url)}`, () => {
      const result = evaluateSourceUrl(c.url);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.scheme).toBe(c.scheme);
        expect(result.host).toBe(c.host);
      }
      expect(isAllowedSourceUrl(c.url)).toBe(true);
    });
  }
});

describe("evaluateSourceUrl — forbidden forms", () => {
  for (const c of DENIED) {
    test(`denies ${JSON.stringify(c.url)} (${c.reason})`, () => {
      const result = evaluateSourceUrl(c.url);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(c.reason);
      }
      expect(isAllowedSourceUrl(c.url)).toBe(false);
    });
  }
});

describe("evaluateSourceUrl — host extraction", () => {
  test("lowercases https host", () => {
    const result = evaluateSourceUrl("https://GitHub.COM/x/y");
    expect(result).toEqual({ ok: true, scheme: "https", host: "github.com" });
  });

  test("does not treat ssh://git@host as embedded credentials", () => {
    const result = evaluateSourceUrl("ssh://git@example.com/x/y");
    expect(result.ok).toBe(true);
  });
});
