import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactString } from "../contract/redaction.ts";
import { sameGitRemote } from "./lib/platform-release-source.ts";

const REPOSITORY = "tako0614/takosumi";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA = /^[0-9a-f]{40}$/u;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const QUALITY_JOBS = ["static and build", "docs browser", "dashboard browser", "check and test",
  ...Array.from({ length: 6 }, (_, i) => `tests (${i + 1}/6)`)].sort();
type Result = { readonly code: number; readonly stdout: string; readonly stderr: string };
type Run = (program: string, args: readonly string[], input?: string) => Promise<Result>;
type Runtime = { readonly run?: Run; readonly stdout?: (line: string) => void; readonly stderr?: (line: string) => void };
type Selection = { readonly mode: "publish" | "verify"; readonly commit: string; readonly tag: string; readonly ciRun: string; readonly environment: "production" };

function selection(args: readonly string[]): Selection {
  const [mode, ...rest] = args;
  if (mode !== "publish" && mode !== "verify") throw new Error("command must be publish or verify");
  const values: Record<string, string> = {};
  const allowed = new Set(["--environment", "--commit", "--tag", "--ci-run"]);
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!; const value = rest[i + 1];
    if (!allowed.has(key) || Object.hasOwn(values, key) || !value || value.startsWith("--")) throw new Error("unknown, duplicate, or missing release option");
    values[key] = value;
  }
  if (values["--environment"] !== "production") throw new Error("GitHub source release requires explicit --environment production; no integration/rehearsal publication");
  if (!Number.isSafeInteger(Number(values["--ci-run"])) || !SHA.test(values["--commit"] ?? "") || !TAG.test(values["--tag"] ?? "") || !/^[1-9]\d*$/u.test(values["--ci-run"] ?? "")) throw new Error("full --commit, stable --tag v<semver>, and existing --ci-run are required");
  return { mode, environment: "production", commit: values["--commit"]!, tag: values["--tag"]!, ciRun: values["--ci-run"]! };
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK", "GNUPGHOME", "GPG_TTY", "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" };
}

const defaultRun: Run = (program, args, input) => new Promise(resolveResult => {
  const child = execFile(program, [...args], { cwd: ROOT, env: commandEnvironment(), encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolveResult({ code: error ? typeof error.code === "number" ? error.code : 1 : 0, stdout, stderr });
  });
  child.stdin?.end(input ?? "");
});

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function digest(text: string): string { return `sha256:${createHash("sha256").update(text).digest("hex")}`; }

/** One provider/process seam. There is no dry-run flag that can relax a guard. */
export async function runOssGitHubRelease(args: readonly string[], runtime: Runtime = {}): Promise<number> {
  const run = runtime.run ?? defaultRun;
  const write = runtime.stdout ?? (line => process.stdout.write(`${line}\n`));
  const diagnose = runtime.stderr ?? (line => process.stderr.write(`${line}\n`));
  let signerFingerprint: string | undefined;
  let stage = "before-mutation";
  let selected: Selection | undefined;
  const checked = async (program: string, argv: readonly string[], input?: string) => {
    const result = await run(program, argv, input);
    if (result.code !== 0) {
      if (result.stderr) diagnose(redactString(result.stderr));
      if (result.stdout && program === "git" && ["push", "fetch", "verify-tag", "tag"].includes(argv[1] ?? "")) diagnose(redactString(result.stdout));
      throw new Error(`${program} failed at ${stage} (exit ${result.code})`);
    }
    if (program === "git" && argv[1] === "verify-tag") {
      signerFingerprint = `${result.stdout} ${result.stderr}`.match(/SHA256:[A-Za-z0-9+/=]+/u)?.[0];
    }
    return result.stdout;
  };
  const git = (...argv: string[]) => checked("git", ["--no-replace-objects", ...argv]);
  const api = async (path: string, method = "GET", body?: unknown, absentAllowed = false): Promise<Record<string, unknown> | undefined> => {
    const result = await run("gh", ["api", "--hostname", "github.com", "--include", "--method", method, "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10", `repos/${REPOSITORY}${path}`, ...(body === undefined ? [] : ["--input", "-"])], body === undefined ? undefined : JSON.stringify(body));
    const boundary = /\r?\n\r?\n/u.exec(result.stdout);
    const headers = boundary ? result.stdout.slice(0, boundary.index) : "";
    const bodyText = boundary ? result.stdout.slice(boundary.index + boundary[0].length) : undefined;
    const match = /^HTTP\/[^\s]+\s+(\d{3})(?:\s|$)/u.exec(headers);
    let value: unknown;
    try { value = bodyText === undefined ? undefined : JSON.parse(bodyText); } catch { value = undefined; }
    const status = match ? Number(match[1]) : 0;
    if (absentAllowed && status === 404 && record(value) && value.message === "Not Found") return undefined;
    if (result.code !== 0 || status < 200 || status > 299 || !record(value)) {
      if (result.stderr) diagnose(redactString(result.stderr));
      if (bodyText) diagnose(redactString(bodyText));
      else if (result.stdout) diagnose(redactString(result.stdout));
      throw new Error(`GitHub ${method} ${path} unavailable or invalid (HTTP ${status || "unknown"})`);
    }
    return value;
  };
  try {
    selected = selection(args);
    const s = selected;
    const origin = (await git("remote", "get-url", "origin")).trim();
    const pushOrigins = (await git("remote", "get-url", "--push", "--all", "origin")).trim().split(/\r?\n/u);
    if (!sameGitRemote(origin, `https://github.com/${REPOSITORY}`) || pushOrigins.length !== 1 || !sameGitRemote(pushOrigins[0]!, origin)) throw new Error("origin and its sole push destination must be the owning GitHub repository");
    const repository = await api("");
    if (repository?.full_name !== REPOSITORY || !record(repository.permissions) || repository.permissions.push !== true) throw new Error("authenticated owning repository write access is required; absence must not be inferred from inaccessible releases");
    const assertSource = async () => {
      if ((await git("status", "--porcelain=v1", "--untracked-files=all")).trim()) throw new Error("release worktree must be clean");
      if ((await git("rev-parse", "HEAD")).trim() !== s.commit) throw new Error("HEAD differs from exact selected commit");
      const main = (await git("ls-remote", "origin", "refs/heads/main")).trim();
      if (main !== `${s.commit}\trefs/heads/main`) throw new Error("selected commit must be the exact current origin/main");
    };
    if (s.mode === "publish") await assertSource();
    let manifest: unknown;
    try { manifest = JSON.parse(await git("show", `${s.commit}:package.json`)); } catch { throw new Error("selected commit package.json is unavailable"); }
    if (!record(manifest) || manifest.name !== "@takosjp/takosumi" || manifest.private !== true || manifest.version !== s.tag.slice(1)) throw new Error("selected tag must match the private root software version");
    const notesPath = `docs/releases/${s.tag}.md`;
    const notes = await git("show", `${s.commit}:${notesPath}`);
    if (!notes.startsWith(`# Takosumi ${s.tag}\n`) || Buffer.byteLength(notes) > 256 * 1024 || /\u0000/u.test(notes)) throw new Error("public release notes are missing, mismatched, or oversized");
    const quality = await api(`/actions/runs/${s.ciRun}`);
    if (quality?.head_sha !== s.commit || quality.head_branch !== "main" || quality.event !== "push" || quality.path !== ".github/workflows/quality.yml" || quality.status !== "completed" || quality.conclusion !== "success" || !record(quality.repository) || quality.repository.full_name !== REPOSITORY || !record(quality.head_repository) || quality.head_repository.full_name !== REPOSITORY || !Number.isSafeInteger(quality.run_attempt) || Number(quality.run_attempt) < 1) throw new Error("existing quality run must be successful exact-commit main push from the owning workflow/repository");
    const jobs = await api(`/actions/runs/${s.ciRun}/jobs?filter=latest&per_page=100`);
    if (!Array.isArray(jobs?.jobs) || jobs.total_count !== QUALITY_JOBS.length || jobs.jobs.length !== QUALITY_JOBS.length || jobs.jobs.some(j => !record(j) || j.run_id !== Number(s.ciRun) || j.status !== "completed" || j.conclusion !== "success") || JSON.stringify(jobs.jobs.map(j => (j as Record<string, unknown>).name).sort()) !== JSON.stringify(QUALITY_JOBS)) throw new Error("existing quality run must cover every complete owner gate job without skips");
    const assertTagHeader = async (ref: string) => {
      const object = await git("cat-file", "tag", ref);
      const headers = object.split("\n\n", 1)[0]!.split("\n");
      if (headers.length !== 4 || headers[0] !== `object ${s.commit}` || headers[1] !== "type commit" || headers[2] !== `tag ${s.tag}` || !headers[3]?.startsWith("tagger ")) throw new Error("signed tag header object/type/version mismatch");
    };
    const remoteTag = async () => (await git("ls-remote", "origin", `refs/tags/${s.tag}`, `refs/tags/${s.tag}^{}`)).trim();
    const readRelease = () => api(`/releases/tags/${encodeURIComponent(s.tag)}`, "GET", undefined, true);
    const verifyPublished = async (expectedTagObject?: string, fetchTag = true) => {
      const refs = await remoteTag();
      const release = await readRelease();
      if (!refs && !release) return { status: "absent" };
      if (!refs) throw new Error("Release exists without the selected signed tag");
      const lines = refs.split(/\r?\n/u);
      const tagLine = lines.find(line => line.endsWith(`\trefs/tags/${s.tag}`));
      const peeledLine = lines.find(line => line.endsWith(`\trefs/tags/${s.tag}^{}`));
      const oid = tagLine?.split("\t")[0];
      if (lines.length !== 2 || !oid || !SHA.test(oid) || peeledLine !== `${s.commit}\trefs/tags/${s.tag}^{}` || expectedTagObject !== undefined && oid !== expectedTagObject) throw new Error("published annotated tag object/commit mismatch");
      // Consumer readback fetches only this identity; never fetches or overwrites other tags.
      if (fetchTag) {
        await git("fetch", "--no-tags", "origin", `refs/tags/${s.tag}`);
        if ((await git("rev-parse", "FETCH_HEAD")).trim() !== oid || (await git("rev-parse", "FETCH_HEAD^{commit}")).trim() !== s.commit) throw new Error("fetched tag identity mismatch");
        await git("verify-tag", "FETCH_HEAD");
        await assertTagHeader("FETCH_HEAD");
      }
      if (!release) return { status: "tag-only", tagObject: oid, ...(signerFingerprint ? { signerFingerprint } : {}) };
      // GitHub ignores target_commitish when the tag exists. The verified
      // signed tag header and peeled commit above are the source authority.
      if (release.tag_name !== s.tag || release.name !== `Takosumi ${s.tag}` || release.draft !== false || release.prerelease !== false || release.body !== notes || !Array.isArray(release.assets) || release.assets.length !== 0 || !Number.isSafeInteger(release.id) || Number(release.id) < 1 || release.html_url !== `https://github.com/${REPOSITORY}/releases/tag/${s.tag}`) throw new Error("GitHub Release source/tag/notes/assets identity mismatch");
      return { status: "published", tagObject: oid, releaseId: release.id, url: release.html_url, ...(signerFingerprint ? { signerFingerprint } : {}) };
    };
    if (s.mode === "verify") {
      const observed = await verifyPublished();
      write(JSON.stringify({ kind: "takosumi.oss-github-release@v1", environment: s.environment, repository: REPOSITORY, commit: s.commit, tag: s.tag, notesPath, notesDigest: digest(notes), ciRun: s.ciRun, ...observed }));
      return observed.status === "published" ? 0 : 1;
    }
    const local = await run("git", ["--no-replace-objects", "show-ref", "--verify", "--quiet", `refs/tags/${s.tag}`]);
    if (local.code !== 1) throw new Error(local.code === 0 ? "local tag already exists; never overwrite or retry it" : "local tag absence could not be established");
    if (await remoteTag() || await readRelease()) throw new Error("tag or Release already exists; use verify, never overwrite or resume blindly");
    if (!(await git("config", "--get", "user.signingkey")).trim()) throw new Error("existing signing key is required; do not create a new key");
    await assertSource();
    stage = "local-signing";
    await git("tag", "-s", s.tag, s.commit, "-m", `Takosumi ${s.tag}`);
    await git("verify-tag", s.tag);
    await assertTagHeader(`refs/tags/${s.tag}`);
    const tagObject = (await git("rev-parse", `refs/tags/${s.tag}`)).trim();
    if (!SHA.test(tagObject) || (await git("rev-parse", `${s.tag}^{commit}`)).trim() !== s.commit) throw new Error("local signed tag identity mismatch");
    await assertSource();
    stage = "tag-push";
    await git("push", "origin", `refs/tags/${s.tag}:refs/tags/${s.tag}`);
    stage = "tag-readback";
    const tagged = await verifyPublished(tagObject);
    if (tagged.status !== "tag-only") throw new Error("unexpected Release appeared during tag publication; halt");
    stage = "release-create";
    await api("/releases", "POST", { tag_name: s.tag, target_commitish: s.commit, name: `Takosumi ${s.tag}`, body: notes, draft: false, prerelease: false });
    stage = "release-readback";
    const published = await verifyPublished(tagObject, false);
    if (published.status !== "published") throw new Error("publication readback is incomplete");
    write(JSON.stringify({ kind: "takosumi.oss-github-release@v1", environment: s.environment, repository: REPOSITORY, commit: s.commit, tag: s.tag, notesPath, notesDigest: digest(notes), ciRun: s.ciRun, ...published }));
    return 0;
  } catch (error) {
    const message = redactString(error instanceof Error ? error.message : String(error));
    write(JSON.stringify({ kind: "takosumi.oss-github-release@v1", status: stage === "before-mutation" ? "refused" : "indeterminate", stage, ...(selected ? { environment: selected.environment, tag: selected.tag, commit: selected.commit } : {}), error: message, next: "inspect the exact local/remote tag and Release with verify; no blind retry, edit, delete, or force push" }));
    return 1;
  }
}
