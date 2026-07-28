#!/usr/bin/env bun

// takosumi の唯一の deploy entrypoint です。
//
// 共通の obligation と trigger は takos-control の
// `engineering.policy.json` → `deploy` が正本です。この repo は複数の surface を
// 持つので、surface 名を引数で選びます。
//
//   bun run deploy -- website
//
// `--contract` は副作用なしで、この repo が publish できる surface と、それぞれの
// trigger・義務の果たし方を印字します。takos-control の
// `scripts/check-deploy-contract.mjs` がそれを probe し、負う義務すべてに答えが
// あること、前回の snapshot から答えが変わっていないことを確認します。
//
// platform worker は operator の realized config を要求します。repo の
// `deploy/platform/wrangler.toml` は self-host 向けの placeholder なので、
// `TAKOSUMI_WRANGLER_CONFIG` が必要です。control-ledger の D1 予備適用は
// この entrypoint の外の deliberate な手順で、docs/operations/ が持ちます。

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER_GATE = "bun run check";

const PLATFORM = {
  surface: "takosumi-platform-worker",
  worker: "takosumi-platform",
  configEnv: "TAKOSUMI_WRANGLER_CONFIG",
  tokenEnv: "TAKOSUMI_DEPLOY_CONTROL_TOKEN",
  base: "https://app.takosumi.com",
  // rule 4: 実データを読む認証済み request。healthz の 200 は証拠ではない。
  probePath: "/api/v1/workspaces",
};

const WEBSITE = {
  surface: "takosumi-website",
  project: "takosumi-website",
  productionBranch: "main",
  outputDir: "website/.output/public",
  site: "https://takosumi.com",
  build: ["bash", "website/build.sh"],
};

const CONTRACT = {
  kind: "takos.deploy-contract@v2",
  surfaces: [
    {
      surface: WEBSITE.surface,
      target: `cloudflare-pages:${WEBSITE.project}`,
      covers: ["website/wrangler.toml"],
      outputDir: WEBSITE.outputDir,
      // takosumi.com は landing + VitePress docs を重ねた prerendered な公開
      // バイト列だけです。durable state も server handler も target 側
      // credential も持たず、消費者が pin する identity も発行しません。
      triggers: [],
      obligations: {
        provenance: `refuses a dirty worktree, builds ${WEBSITE.outputDir} with \`${WEBSITE.build.join(" ")}\` from that worktree — which is what validates these bytes, since the landing and the VitePress docs both have to compile — scans the output for credential material, and records the commit and the index.html sha256. It deliberately does not run the repository-wide gate: the Go provider suite and the control-plane tests cannot fail because of a documentation page, and gating a typo fix on them blocks publishing for reasons unrelated to what is being published.`,
        "post-conditions": `fetches the immutable deployment URL and ${WEBSITE.site}/ and requires both to serve the exact index.html digest just built, then requires ${WEBSITE.site}/docs/ to return 200`,
        reversal: `the previous production deployment id is read and printed before publishing; restore it with \`wrangler pages deployment list --project-name ${WEBSITE.project}\` and a rollback to that id`,
        "failure-handling":
          "prints the provider's own stdout and stderr, names whether the failure was before or after publication, and on a readback mismatch exits non-zero naming the previous deployment instead of retrying",
      },
    },
    {
      surface: PLATFORM.surface,
      target: `cloudflare-worker:${PLATFORM.worker}`,
      covers: ["deploy/platform/wrangler.toml"],
      // Worker の code 差し替え自体は version で戻せます。ただしこの worker は
      // Accounts / authorization / billing を実装しているので、その挙動を変える
      // deploy は authority に触れます。判別に迷う側ではなく厳しい側を取ります。
      // control-ledger の schema 変更は別の deliberate な手順であり、この
      // surface の副作用としては起きません。
      triggers: ["authority"],
      obligations: {
        provenance: `refuses a dirty worktree, runs \`${OWNER_GATE}\`, builds the dashboard and docs from that worktree, and records the commit and the deployed version id`,
        "post-conditions": `after publishing, makes an authenticated GET to ${PLATFORM.base}${PLATFORM.probePath} with ${PLATFORM.tokenEnv} and requires a 2xx that returns real data; a 200 from a health endpoint is not accepted, because production served 200 on /healthz for six hours while every API call returned 500`,
        reversal: `the current version id is read and printed before publishing; restore it with \`wrangler versions list\` and \`wrangler versions deploy <previous-id>@100%\` against the same realized config`,
        "failure-handling":
          "prints the provider's own stdout and stderr, names whether the failure was before or after publication, and on a failed post-condition exits non-zero naming the previous version instead of retrying",
        "independent-review":
          "the deploy refuses to run unless TAKOSUMI_PLATFORM_REVIEW names what reviewed this change and did not author it — a person, a non-authoring agent, or a dated deliberate re-read. The value is echoed into the result object so it stays with the record of what shipped.",
      },
    },
  ],
};

if (process.argv.includes("--contract")) {
  process.stdout.write(`${JSON.stringify(CONTRACT, null, 2)}\n`);
  process.exit(0);
}

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const known = CONTRACT.surfaces.map((entry) => entry.surface);
if (requested.length !== 1 || !known.includes(requested[0])) {
  process.stderr.write(
    `usage: bun run deploy -- <surface>\nknown surfaces: ${known.join(", ")}\n`,
  );
  process.exit(1);
}

const selected = requested[0];

function die(message, detail = []) {
  process.stderr.write(`deploy blocked: ${message}\n`);
  for (const line of detail) process.stderr.write(`- ${line}\n`);
  process.exit(1);
}

function git(...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function run(command, args) {
  return execFileSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

if (selected === PLATFORM.surface) {
  await deployPlatform();
  process.exit(0);
}

// provenance: 公開バイト列を一つの commit に結び付ける。
const dirty = git("status", "--porcelain");
if (dirty !== "") {
  die(
    "the worktree is not clean; published bytes must belong to one commit",
    dirty.split("\n").slice(0, 20),
  );
}
const commit = git("rev-parse", "HEAD");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const subject = git("log", "-1", "--format=%s");
process.stdout.write(`source ${commit} (${branch})\n`);

// The build is the gate for these bytes. The landing and the docs both have to
// compile, and a broken page fails here. The repository-wide `bun run check`
// covers the Go provider, the control plane, and the runner — none of which can
// be broken by a documentation change, and all of which would block one.
process.stdout.write(`\n==> ${WEBSITE.build.join(" ")}\n`);
execFileSync(WEBSITE.build[0], WEBSITE.build.slice(1), {
  cwd: repo,
  stdio: "inherit",
});

const outputRoot = resolve(repo, WEBSITE.outputDir);
if (!existsSync(join(outputRoot, "index.html"))) {
  die(`${WEBSITE.outputDir}/index.html is missing after the build`);
}

// 公開されるバイト列に credential 形状のものが混ざっていないことを確認する。
const CREDENTIAL_SHAPES = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk_live_[0-9A-Za-z]{16,}/u,
  /\bgh[pousr]_[0-9A-Za-z]{30,}/u,
  /\bCLOUDFLARE_API_(?:TOKEN|KEY)\s*[=:]/u,
];
const published = walk(outputRoot);
const leaks = [];
for (const path of published) {
  const name = relative(outputRoot, path);
  if (/(^|\/)\.env(\.|$)|\.pem$|\.p12$|\.pfx$|\.key$/u.test(name)) {
    leaks.push(`${name}: credential-shaped file`);
    continue;
  }
  if (/\.(?:png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf|mp4|pdf|wasm)$/u.test(name)) continue;
  for (const shape of CREDENTIAL_SHAPES) {
    if (shape.test(readFileSync(path, "utf8"))) leaks.push(`${name}: matches ${shape}`);
  }
}
if (leaks.length > 0) die("the built site contains credential material", leaks);

const indexDigest = digest(readFileSync(join(outputRoot, "index.html")));
process.stdout.write(
  `\ncandidate ${published.length} files, index.html sha256 ${indexDigest.slice(0, 16)}\n`,
);

// reversal: 戻し先を先に読む。読めなければ publish しない。
let previous = null;
try {
  const listed = run("wrangler", [
    "pages", "deployment", "list", "--project-name", WEBSITE.project,
  ]);
  previous =
    listed.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/u)?.[1] ?? null;
} catch (error) {
  die(`cannot read the current deployment list: ${error.message}`);
}
if (!previous) {
  die("no previous production deployment was readable, so there is no revert point");
}
process.stdout.write(`previous production deployment ${previous}\n`);

process.stdout.write(`\n==> publishing ${WEBSITE.outputDir} to ${WEBSITE.project}\n`);
let output;
try {
  output = run("wrangler", [
    "pages", "deploy", WEBSITE.outputDir,
    "--project-name", WEBSITE.project,
    "--branch", WEBSITE.productionBranch,
    "--commit-hash", commit,
    "--commit-message", subject,
    "--commit-dirty=false",
  ]);
} catch (error) {
  process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}\n`);
  die(
    "publication failed; production may be unchanged or partially updated. " +
      `Reconcile against deployment ${previous} before retrying.`,
  );
}
process.stdout.write(output);

const deploymentUrl = output.match(
  new RegExp(`https://[0-9a-z-]+\\.${WEBSITE.project}\\.pages\\.dev`, "u"),
)?.[0];
if (!deploymentUrl) {
  die(
    "the publication command printed no deployment URL, so the result is indeterminate; " +
      `read the authoritative deployment list before retrying (previous ${previous})`,
  );
}

// post-conditions: 実際に配られているバイト列が、いま build したものであること。
async function servedDigest(url) {
  const response = await fetch(url, {
    headers: { "cache-control": "no-cache" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return digest(Buffer.from(await response.arrayBuffer()));
}

async function waitFor(url, expected, attempts) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      last = await servedDigest(url);
      if (last === expected) return true;
    } catch (error) {
      last = `error: ${error.message}`;
    }
    if (attempt < attempts) await new Promise((wake) => setTimeout(wake, 3000 * attempt));
  }
  process.stderr.write(`readback mismatch at ${url}: ${last}\n`);
  return false;
}

const immutableOk = await waitFor(deploymentUrl, indexDigest, 5);
const productionOk = await waitFor(`${WEBSITE.site}/`, indexDigest, 8);
// docs/ は別ビルドを重ねた区画なので、landing だけの一致では出ていない。
let docsOk = false;
try {
  docsOk = (await fetch(`${WEBSITE.site}/docs/`, { redirect: "follow" })).ok;
} catch {
  docsOk = false;
}

const result = {
  kind: "takos.deploy-result@v1",
  surface: WEBSITE.surface,
  target: `cloudflare-pages:${WEBSITE.project}`,
  commit,
  branch,
  indexDigest,
  files: published.length,
  deploymentUrl,
  previousDeployment: previous,
  immutableReadback: immutableOk ? "EXPECTED_CANDIDATE" : "MISMATCH",
  productionReadback: productionOk ? "EXPECTED_CANDIDATE" : "MISMATCH",
  docsReachable: docsOk,
  status: immutableOk && productionOk && docsOk ? "PUBLISHED" : "INDETERMINATE",
};
process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`);

if (result.status !== "PUBLISHED") {
  process.stderr.write(
    `\nthe published deployment ${deploymentUrl} exists but the post-conditions did not hold. ` +
      `Do not retry blindly: compare it against previous deployment ${previous} first.\n`,
  );
  process.exit(1);
}


async function deployPlatform() {
  const configPath = process.env[PLATFORM.configEnv];
  if (!configPath) {
    die(
      `${PLATFORM.configEnv} is not set. deploy/platform/wrangler.toml in this repository is a ` +
        `self-host placeholder, not the operator's realized config; publishing it would target the wrong account.`,
    );
  }
  if (!existsSync(configPath)) die(`${PLATFORM.configEnv} points at ${configPath}, which does not exist`);

  const token = process.env[PLATFORM.tokenEnv];
  if (!token) {
    die(
      `${PLATFORM.tokenEnv} is not set. This surface's post-condition is an authenticated request that ` +
        `reads real data; a deploy whose success cannot be observed is not a success.`,
    );
  }

  // independent-review は authority trigger が要求します。誰が見たかを名乗らせ、
  // 出荷記録に残します。強制はできませんが、空欄では進みません。
  const review = process.env.TAKOSUMI_PLATFORM_REVIEW;
  if (!review || review.trim().length === 0) {
    die(
      "TAKOSUMI_PLATFORM_REVIEW is not set. This surface carries the authority trigger, so name what " +
        "reviewed this change and did not author it — a person, a non-authoring agent, or a dated re-read.",
    );
  }

  const dirtyTree = git("status", "--porcelain");
  if (dirtyTree !== "") {
    die("the worktree is not clean; the deployed bundle must belong to one commit", dirtyTree.split("\n").slice(0, 20));
  }
  const commit = git("rev-parse", "HEAD");
  process.stdout.write(`source ${commit} (${git("rev-parse", "--abbrev-ref", "HEAD")})\n`);
  process.stdout.write(`reviewed by: ${review}\n`);

  process.stdout.write(`\n==> ${OWNER_GATE}\n`);
  execFileSync("bun", ["run", "check"], { cwd: repo, stdio: "inherit" });

  process.stdout.write("\n==> dashboard and docs build\n");
  execFileSync("bun", ["run", "build"], { cwd: resolve(repo, "dashboard"), stdio: "inherit" });
  execFileSync("bun", ["run", "docs:build"], { cwd: repo, stdio: "inherit" });

  let previous = null;
  try {
    const listed = run("wrangler", ["versions", "list", "--config", configPath]);
    previous = listed.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/u)?.[1] ?? null;
  } catch (error) {
    die(`cannot read the current version list: ${error.message}`);
  }
  if (!previous) die("no current version was readable, so there is no revert point");
  process.stdout.write(`previous version ${previous}\n`);

  process.stdout.write(`\n==> publishing ${PLATFORM.worker}\n`);
  let output;
  try {
    output = run("wrangler", ["deploy", "--config", configPath]);
  } catch (error) {
    process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}\n`);
    die(
      "publication failed; production may be unchanged or partially updated. " +
        `Reconcile against version ${previous} before retrying.`,
    );
  }
  process.stdout.write(output);

  // post-conditions: 実データを読む認証済み request。
  let postOk = false;
  let postDetail = null;
  const url = `${PLATFORM.base}${PLATFORM.probePath}`;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      process.stdout.write(`\n==> GET ${url}\n`);
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, "cache-control": "no-cache" },
      });
      const body = await response.text();
      if (response.ok) {
        postDetail = `${url} → ${response.status}, ${body.length} bytes`;
        postOk = true;
        break;
      }
      postDetail = `${url} → ${response.status}`;
    } catch (error) {
      postDetail = `${url} → ${error.message}`;
    }
    if (attempt < 5) await new Promise((wake) => setTimeout(wake, 3000 * attempt));
  }
  process.stdout.write(`${postDetail}\n`);

  const result = {
    kind: "takos.deploy-result@v1",
    surface: PLATFORM.surface,
    target: `cloudflare-worker:${PLATFORM.worker}`,
    commit,
    reviewedBy: review,
    previousVersion: previous,
    postConditions: postOk ? "PASSED" : "FAILED",
    status: postOk ? "PUBLISHED" : "INDETERMINATE",
  };
  process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`);

  if (!postOk) {
    process.stderr.write(
      `\nthe new version is live but the authenticated post-condition did not pass. ` +
        `Do not retry blindly: read the authoritative version list and decide whether to roll back to ${previous}.\n`,
    );
    process.exit(1);
  }
}
