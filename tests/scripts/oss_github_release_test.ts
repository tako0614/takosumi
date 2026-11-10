import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { runOssGitHubRelease } from "../../scripts/oss-github-release.ts";

const COMMIT = "a".repeat(40);
const OID = "b".repeat(40);
const TAG = "v2.0.0";
const NOTES = `# Takosumi ${TAG}\n\nPublic source/module notes.\n`;
const JOBS = ["static and build", "docs browser", "dashboard browser", "check and test", ...Array.from({ length: 6 }, (_, i) => `tests (${i + 1}/6)`)];
const ARGS = ["publish", "--environment", "production", "--tag", TAG, "--commit", COMMIT, "--ci-run", "123"];
type Command = { program: string; args: readonly string[]; input?: string };
type Response = { code: number; stdout: string; stderr: string };
type Options = {
  tag?: string;
  initialTag?: boolean; initialRelease?: boolean; localTag?: boolean; dirty?: boolean;
  changedHead?: boolean; changedMain?: boolean; wrongOrigin?: boolean; noWriteAccess?: boolean;
  rootVersion?: string; notes?: string; quality?: Record<string, unknown>;
  jobs?: { name: string; run_id: number; status: string; conclusion: string }[];
  intercept?: (command: Command) => Response | undefined;
  losePushAck?: boolean; loseReleaseAck?: boolean; failSignature?: boolean;
  badReleaseReadback?: boolean; moveMainAfterSign?: boolean;
};

function fixture(options: Options = {}) {
  const tag = options.tag ?? TAG;
  const notes = options.notes ?? `# Takosumi ${tag}\n\nPublic source/module notes.\n`;
  const calls: Command[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  let signed = options.localTag === true;
  let pushed = options.initialTag === true;
  let release = options.initialRelease === true;
  const ok = (stdout = ""): Response => ({ code: 0, stdout, stderr: "" });
  const http = (status: number, body: unknown): Response => ({ code: status >= 400 ? 1 : 0, stdout: `HTTP/2.0 ${status} Response\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`, stderr: "" });
  const run = async (program: string, rawArgs: readonly string[], input?: string): Promise<Response> => {
    const args = program === "git" ? rawArgs.slice(1) : rawArgs;
    const call = { program, args, input }; calls.push(call);
    const intercepted = options.intercept?.(call);
    if (intercepted) return intercepted;
    if (program === "git") {
      expect(rawArgs[0]).toBe("--no-replace-objects");
      if (args[0] === "remote") return ok(options.wrongOrigin ? "https://github.com/other/fork.git\n" : "git@github.com:tako0614/takosumi.git\n");
      if (args[0] === "status") return ok(options.dirty ? " M package.json\n" : "");
      if (args[0] === "ls-remote") {
        if (args[2] === "refs/heads/main") return ok(`${options.changedMain || options.moveMainAfterSign && signed ? "c".repeat(40) : COMMIT}\trefs/heads/main\n`);
        return ok(pushed ? `${OID}\trefs/tags/${tag}\n${COMMIT}\trefs/tags/${tag}^{}\n` : "");
      }
      if (args[0] === "show") return ok(args[1]?.endsWith(":package.json")
        ? JSON.stringify({ name: "@takosjp/takosumi", private: true, version: options.rootVersion ?? tag.slice(1) })
        : options.notes ?? notes);
      if (args[0] === "show-ref") return { code: signed ? 0 : 1, stdout: "", stderr: "" };
      if (args[0] === "config") return ok("configured-existing-key\n");
      if (args[0] === "tag") { signed = true; return ok(); }
      if (args[0] === "cat-file") return ok(`object ${COMMIT}\ntype commit\ntag ${tag}\ntagger Publisher <publisher@example.test> 1 +0000\n\nSigned tag.\n`);
      if (args[0] === "verify-tag") return options.failSignature ? { code: 1, stdout: "", stderr: "signature verification failed" } : { code: 0, stdout: "", stderr: "Good signature with ED25519 key SHA256:syntheticFingerprint" };
      if (args[0] === "rev-parse") return ok(`${args[1] === "HEAD" ? options.changedHead ? "c".repeat(40) : COMMIT : args[1]?.endsWith("^{commit}") ? COMMIT : OID}\n`);
      if (args[0] === "push") {
        expect(args).toEqual(["push", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
        pushed = true;
        return options.losePushAck ? { code: 1, stdout: "", stderr: "response lost" } : ok();
      }
      if (args[0] === "fetch") { expect(args).toEqual(["fetch", "--no-tags", "origin", `refs/tags/${tag}`]); return ok(); }
    }
    if (program === "gh") {
      const method = args[args.indexOf("--method") + 1];
      const path = args.find(a => a.startsWith("repos/"))!;
      expect(args.slice(0, 5)).toEqual(["api", "--hostname", "github.com", "--include", "--method"]);
      if (path === "repos/tako0614/takosumi") return http(200, { full_name: "tako0614/takosumi", permissions: { push: !options.noWriteAccess } });
      if (path.endsWith("/actions/runs/123")) return http(200, { head_sha: COMMIT, head_branch: "main", event: "push", path: ".github/workflows/quality.yml", status: "completed", conclusion: "success", repository: { full_name: "tako0614/takosumi" }, head_repository: { full_name: "tako0614/takosumi" }, run_attempt: 1, ...options.quality });
      if (path.includes("/jobs?")) {
        const jobs = options.jobs ?? JOBS.map(name => ({ name, run_id: 123, status: "completed", conclusion: "success" }));
        return http(200, { total_count: jobs.length, jobs });
      }
      if (path.endsWith("/releases") && method === "POST") {
        expect(pushed).toBe(true);
        expect(JSON.parse(input!)).toEqual({ tag_name: tag, target_commitish: COMMIT, name: `Takosumi ${tag}`, body: notes, draft: false, prerelease: false });
        release = true;
        return options.loseReleaseAck ? { code: 1, stdout: "", stderr: "response lost" } : http(201, { id: 9 });
      }
      if (path.includes("/releases/tags/")) return release ? http(200, { tag_name: tag, target_commitish: COMMIT, name: `Takosumi ${tag}`, body: options.badReleaseReadback ? "different bytes" : notes, draft: false, prerelease: false, assets: [], id: 9, html_url: `https://github.com/tako0614/takosumi/releases/tag/${tag}` }) : http(404, { message: "Not Found" });
    }
    throw new Error(`unexpected command ${program} ${args.join(" ")}`);
  };
  const defaultArgs = [...ARGS]; defaultArgs[4] = tag;
  return {
    calls, output, errors,
    invoke: (args: readonly string[] = defaultArgs) => runOssGitHubRelease(args, { run, stdout: line => output.push(line), stderr: line => errors.push(line) }),
    result: () => JSON.parse(output.at(-1)!),
    mutations: () => calls.filter(c => c.program === "git" && ["tag", "push"].includes(c.args[0]!) || c.program === "gh" && c.args[c.args.indexOf("--method") + 1] === "POST"),
  };
}

test("publishes one signed immutable source identity with existing exact CI and no repeated gate/build", async () => {
  const f = fixture(); expect(await f.invoke()).toBe(0);
  expect(f.result()).toMatchObject({ signerFingerprint: "SHA256:syntheticFingerprint", status: "published", tag: TAG, commit: COMMIT, tagObject: OID, ciRun: "123", notesPath: `docs/releases/${TAG}.md` });
  expect(f.mutations()).toHaveLength(3);
  expect(f.calls.filter(c => c.args[0] === "fetch")).toHaveLength(1);
  expect(f.calls.filter(c => c.program === "gh" && c.args.some(a => a.endsWith("/actions/runs/123")))).toHaveLength(1);
  expect(f.calls.every(c => ["git", "gh"].includes(c.program))).toBe(true);
  expect(f.output.join("\n")).not.toContain("configured-existing-key");
});

for (const opts of [{ dirty: true }, { changedHead: true }, { changedMain: true }, { wrongOrigin: true }, { noWriteAccess: true }, { rootVersion: "1.0.0" }, { notes: "wrong notes" }, { localTag: true }, { initialTag: true }, { initialRelease: true }]) {
  test(`preflight refuses before any mutation: ${JSON.stringify(opts)}`, async () => {
    const f = fixture(opts); expect(await f.invoke()).toBe(1); expect(f.mutations()).toHaveLength(0); expect(f.result().status).toBe("refused");
  });
}
for (const quality of [{ head_sha: "c".repeat(40) }, { event: "pull_request" }, { head_branch: "feature" }, { path: ".github/workflows/other.yml" }, { conclusion: "failure" }, { status: "in_progress" }, { repository: { full_name: "other/fork" } }, { head_repository: { full_name: "other/fork" } }, { run_attempt: 0 }]) {
  test(`wrong CI cannot authorize publication: ${JSON.stringify(quality)}`, async () => {
    const f = fixture({ quality }); expect(await f.invoke()).toBe(1); expect(f.mutations()).toHaveLength(0);
  });
}
for (const badJob of ["skipped", "failure", "cancelled"]) {
  test(`no incomplete gate coverage: ${badJob}`, async () => {
    const jobs = JOBS.map(name => ({ name, run_id: 123, status: "completed", conclusion: "success" })); jobs[0]!.conclusion = badJob;
    const f = fixture({ jobs }); expect(await f.invoke()).toBe(1); expect(f.mutations()).toHaveLength(0);
  });
}
for (const environment of ["integration", "rehearsal", "", "staging"]) {
  test(`environment ${environment} cannot create public identities`, async () => {
    const f = fixture(); const args = [...ARGS]; args[2] = environment;
    expect(await f.invoke(args)).toBe(1); expect(f.calls).toHaveLength(0);
  });
}
for (const failure of ["losePushAck", "loseReleaseAck", "failSignature", "badReleaseReadback", "moveMainAfterSign"] as const) {
  test(`failure after signing is indeterminate and never blindly retried: ${failure}`, async () => {
    const f = fixture({ [failure]: true }); expect(await f.invoke()).toBe(1); expect(f.result().status).toBe("indeterminate");
    expect(f.calls.filter(c => c.args[0] === "push").length).toBeLessThanOrEqual(1);
    expect(f.calls.filter(c => c.program === "gh" && c.args[c.args.indexOf("--method") + 1] === "POST").length).toBeLessThanOrEqual(1);
  });
}

test("an auth/network failure is not an absent Release", async () => {
  for (const stdout of ["", "HTTP/2.0 403 Forbidden\r\n\r\n{\"message\":\"Forbidden\"}", "HTTP/2.0 404 Not Found\r\n\r\nnot JSON"]) {
    const f = fixture({ intercept: c => c.program === "gh" && c.args.some(a => a.includes("/releases/tags/")) ? { code: 1, stdout, stderr: "read failed" } : undefined });
    expect(await f.invoke()).toBe(1); expect(f.mutations()).toHaveLength(0);
  }
});

test("verify reconciles published historical exact bytes without any publication mutation", async () => {
  const f = fixture({ initialTag: true, initialRelease: true, dirty: true, changedHead: true, changedMain: true });
  expect(await f.invoke(["verify", ...ARGS.slice(1)])).toBe(0);
  expect(f.result().status).toBe("published"); expect(f.mutations()).toHaveLength(0);
});

test("verify reports tag-only or absent and never creates the missing object", async () => {
  for (const initialTag of [true, false]) {
    const f = fixture({ initialTag }); expect(await f.invoke(["verify", ...ARGS.slice(1)])).toBe(1);
    expect(f.result().status).toBe(initialTag ? "tag-only" : "absent"); expect(f.mutations()).toHaveLength(0);
  }
});


test("verify rejects an otherwise verified signed tag with another internal version", async () => {
  const f = fixture({ initialTag: true, initialRelease: true, intercept: c =>
    c.program === "git" && c.args[0] === "cat-file" ? { code: 0, stdout: `object ${COMMIT}\ntype commit\ntag v1.9.9\ntagger Publisher <publisher@example.test> 1 +0000\n\nSigned tag.\n`, stderr: "" } : undefined });
  expect(await f.invoke(["verify", ...ARGS.slice(1)])).toBe(1);
  expect(f.result().error).toContain("tag header");
  expect(f.mutations()).toHaveLength(0);
});


test("provider stdout diagnostics are retained with credentials redacted", async () => {
  const f = fixture({ intercept: c => c.program === "git" && c.args[0] === "push" ? { code: 1, stdout: "remote: publication rejected; Authorization: Bearer synthetic-private-token", stderr: "" } : undefined });
  expect(await f.invoke()).toBe(1);
  expect(f.errors.join("\n")).toContain("publication rejected");
  expect(f.errors.join("\n")).not.toContain("synthetic-private-token");
  expect(f.result().status).toBe("indeterminate");
});


test("Release target_commitish is metadata when an exact signed tag already exists", async () => {
  const f = fixture({ initialTag: true, initialRelease: true, intercept: c => {
    if (c.program !== "gh" || !c.args.some(a => a.includes("/releases/tags/"))) return undefined;
    return { code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ tag_name: TAG, target_commitish: "main", name: `Takosumi ${TAG}`, body: NOTES, draft: false, prerelease: false, assets: [], id: 9, html_url: `https://github.com/tako0614/takosumi/releases/tag/${TAG}` })}`, stderr: "" };
  } });
  expect(await f.invoke(["verify", ...ARGS.slice(1)])).toBe(0);
  expect(f.result().status).toBe("published");
  expect(f.mutations()).toHaveLength(0);
});


test("the release surface accepts another stable software version without code changes", async () => {
  const f = fixture({ tag: "v3.1.7" }); expect(await f.invoke()).toBe(0);
  expect(f.result()).toMatchObject({ status: "published", tag: "v3.1.7", notesPath: "docs/releases/v3.1.7.md" });
});

for (const field of ["object", "type", "peel"]) {
  test(`verify rejects a mismatched signed-tag ${field}`, async () => {
    const f = fixture({ initialTag: true, initialRelease: true, intercept: c => {
      if (c.program !== "git") return undefined;
      if (field === "peel" && c.args[0] === "ls-remote" && c.args[2]?.startsWith("refs/tags/")) return { code: 0, stdout: `${OID}\trefs/tags/${TAG}\n${"c".repeat(40)}\trefs/tags/${TAG}^{}\n`, stderr: "" };
      if (field !== "peel" && c.args[0] === "cat-file") return { code: 0, stdout: `object ${field === "object" ? "c".repeat(40) : COMMIT}\ntype ${field === "type" ? "tree" : "commit"}\ntag ${TAG}\ntagger Publisher <publisher@example.test> 1 +0000\n\nSigned.\n`, stderr: "" };
      return undefined;
    } });
    expect(await f.invoke(["verify", ...ARGS.slice(1)])).toBe(1); expect(f.mutations()).toHaveLength(0);
  });
}


for (const environment of ["integration", "rehearsal"]) {
  test(`owning public entrypoint refuses ${environment} before process/provider access`, async () => {
    const child = Bun.spawn([process.execPath, "run", "deploy", "--", "takosumi-oss-github-release", "publish", "--environment", environment, "--tag", TAG, "--commit", COMMIT, "--ci-run", "123"], {
      cwd: resolve(import.meta.dir, "../.."), env: { PATH: "", HOME: "/nonexistent", GIT_TERMINAL_PROMPT: "0" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ status: "refused", stage: "before-mutation", error: expect.stringContaining("explicit --environment production") });
    expect(stderr).not.toContain("git failed");
  });
}
