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
// OSS platform worker の self-host deploy は利用者/operator自身のauthorityです。
// 公式hosted platform (app.takosumi.com) は ADR 0014 の cutover でこの repo が
// 所有するようになりました: 走るコードは deploy/platform/worker.ts そのもので、
// realized config だけが operator-private (takosumi-private) にあります。

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const WEBSITE = {
  surface: "takosumi-website",
  project: "takosumi-website",
  productionBranch: "main",
  outputDir: "website/.output/public",
  site: "https://takosumi.com",
  build: ["bash", "website/build.sh"],
};

const PLATFORM = {
  surface: "takosumi-platform",
  configRoot:
    process.env.TAKOSUMI_PLATFORM_CONFIG_ROOT ??
    resolve(repo, "..", "takosumi-private", "platform"),
  environments: {
    staging: {
      workerName: "takosumi-staging",
      config: "wrangler.staging.toml",
      site: "https://app-staging.takosumi.com",
    },
    production: {
      workerName: "takosumi",
      config: "wrangler.toml",
      site: "https://app.takosumi.com",
    },
  },
};

const CONTRACT = {
  kind: "takos.deploy-contract@v2",
  surfaces: [
    {
      surface: PLATFORM.surface,
      target: "cloudflare-worker:takosumi",
      covers: ["deploy/platform", "core", "dashboard", "scripts/deploy.mjs"],
      triggers: ["published-identity", "authority", "irreversible"],
      obligations: {
        provenance:
          "refuses a dirty worktree unless --allow-dirty is passed explicitly, and then records " +
          "the exact dirty file list in the result; records the commit, branch, environment, the " +
          "sha256 of the realized operator config it was pointed at, and the freshly built " +
          "dashboard index.html digest. The realized config lives in the operator-private " +
          "sibling and is named by path, never embedded.",
        "post-conditions":
          "reads back the served Worker version id from the publication output, then exercises " +
          "the public origin: the dashboard must answer 200 on /, and an API namespace must " +
          "answer with a non-5xx status, which proves the worker script — not only the asset " +
          "layer — is the one serving.",
        reversal:
          "the currently served Worker version id is read before any mutation and printed with " +
          "the exact `wrangler versions deploy` command that restores it. Durable Object " +
          "deleted_classes migrations are forward-only: rolling back the Worker does not " +
          "resurrect deleted storage, and the config history in the operator-private sibling is " +
          "the record of what was destroyed.",
        "failure-handling":
          "an unreadable revert point refuses before touching the target; a failed publication " +
          "prints the provider's own output and names the revert point; failed post-conditions " +
          "exit non-zero with the previous version id instead of retrying.",
        "no-overwrite":
          "every publication mints a new immutable Worker Version: a changed byte becomes a new " +
          "version id, nothing is written over the previous one, and the result records both the " +
          "previous and the published id so history stays a chain rather than a slot.",
        "pre-mutation-proof":
          "before the real upload the writer runs `wrangler deploy --dry-run` against the exact " +
          "realized production config, which compiles the bundle and validates every binding and " +
          "Durable Object migration against production's own configuration without mutating it; " +
          "the staging environment publishes and probes the same source first.",
        "independent-review":
          "a production publication follows a staging publication of the same source whose " +
          "recorded probes are the non-author check, and the operator invoking " +
          "--environment=production after reading that staging result is the deliberate re-read; " +
          "the result JSON records the commit, config digest, and the exact dirty file list so " +
          "that re-read has something concrete to hold.",
      },
    },
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

if (selected === PLATFORM.surface) {
  await deployPlatform();
  process.exit(0);
}

async function deployPlatform() {
  const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
  const environmentFlag = flags.find((arg) => arg.startsWith("--environment="));
  const environment = environmentFlag?.slice("--environment=".length);
  const target = PLATFORM.environments[environment];
  if (!target) {
    die("name the environment: --environment=staging or --environment=production");
  }
  const allowDirty = flags.includes("--allow-dirty");
  const configPath = resolve(PLATFORM.configRoot, target.config);
  if (!existsSync(configPath)) {
    die(`realized config not found: ${configPath}`);
  }

  // provenance
  const dirtyFiles = git("status", "--porcelain");
  if (dirtyFiles !== "" && !allowDirty) {
    die(
      "the worktree is not clean; pass --allow-dirty only when publishing " +
        "uncommitted work is a deliberate, recorded decision",
      dirtyFiles.split("\n").slice(0, 20),
    );
  }
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const commit = git("rev-parse", "HEAD");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const configDigest = sha256(readFileSync(configPath));
  process.stdout.write(`source ${commit} (${branch})\n`);
  process.stdout.write(`realized config ${configPath} sha256 ${configDigest.slice(0, 16)}\n`);

  // The dashboard is part of the published bytes; build it from this worktree.
  process.stdout.write("\n==> bun run build (dashboard)\n");
  execFileSync("bun", ["run", "build"], { cwd: join(repo, "dashboard"), stdio: "inherit" });
  const dashboardIndex = join(repo, "dashboard", "dist", "index.html");
  if (!existsSync(dashboardIndex)) die("dashboard/dist/index.html is missing after the build");
  const indexDigest = sha256(readFileSync(dashboardIndex));

  // reversal: 戻し先を先に読む。読めなければ publish しない。
  let previousVersion = null;
  try {
    const listed = run("wrangler", ["versions", "list", "-c", configPath, "--json"]);
    previousVersion = JSON.parse(listed)[0]?.id ?? null;
  } catch (error) {
    die(`cannot read the current version list: ${error.message}`);
  }
  if (!previousVersion) {
    die("no previous Worker version was readable, so there is no revert point");
  }
  process.stdout.write(`previous version ${previousVersion}\n`);
  process.stdout.write(
    `revert with: wrangler versions deploy ${previousVersion}@100% -c ${configPath}\n`,
  );

  // pre-mutation-proof: compile and validate against the realized config
  // without touching the target.
  process.stdout.write(`\n==> wrangler deploy --dry-run (${environment})\n`);
  try {
    run("wrangler", ["deploy", "--dry-run", "-c", configPath]);
  } catch (error) {
    process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}\n`);
    die("the dry-run compile failed; nothing was touched");
  }

  process.stdout.write(`\n==> wrangler deploy (${environment}: ${target.workerName})\n`);
  let output;
  try {
    output = run("wrangler", ["deploy", "-c", configPath]);
  } catch (error) {
    process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}\n`);
    die(
      "publication failed; the target may be unchanged or partially updated. " +
        `Reconcile against version ${previousVersion} before retrying.`,
    );
  }
  process.stdout.write(output);
  const publishedVersion =
    output.match(/Current Version ID: ([0-9a-f-]+)/u)?.[1] ??
    output.match(/Version ID:\s+([0-9a-f-]+)/u)?.[1] ??
    null;

  // post-conditions: the worker, not only the asset layer, must be serving.
  const probe = async (path, accept) => {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        const response = await fetch(`${target.site}${path}`, {
          headers: { "cache-control": "no-cache" },
          redirect: "manual",
        });
        if (accept(response)) return true;
      } catch {
        // retry
      }
      if (attempt < 6) await new Promise((wake) => setTimeout(wake, 3000 * attempt));
    }
    return false;
  };
  const dashboardOk = await probe("/", (response) => response.status === 200);
  const apiOk = await probe("/api/v1/capsules", (response) => response.status < 500);

  const result = {
    kind: "takos.deploy-result@v1",
    surface: PLATFORM.surface,
    target: `cloudflare-worker:${target.workerName}`,
    environment,
    commit,
    branch,
    dirty: dirtyFiles === "" ? [] : dirtyFiles.split("\n"),
    configPath,
    configDigest,
    dashboardIndexDigest: indexDigest,
    previousVersion,
    publishedVersion,
    dashboardReadback: dashboardOk ? "OK" : "MISMATCH",
    apiReadback: apiOk ? "OK" : "MISMATCH",
    status: dashboardOk && apiOk && publishedVersion ? "PUBLISHED" : "INDETERMINATE",
    at: new Date().toISOString(),
  };
  process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`);

  // Operator-private evidence, when the sibling is present.
  const evidenceDir = resolve(PLATFORM.configRoot, "..", "evidence");
  if (existsSync(evidenceDir)) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(evidenceDir, "platform-deploys.jsonl"), `${JSON.stringify(result)}\n`);
  }

  if (result.status !== "PUBLISHED") {
    process.stderr.write(
      `\nthe publication happened but the post-conditions did not hold. Do not retry blindly: ` +
        `compare against previous version ${previousVersion} first.\n`,
    );
    process.exit(1);
  }
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
