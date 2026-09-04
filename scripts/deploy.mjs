#!/usr/bin/env bun

// takosumi の唯一の deploy entrypoint です。
//
// 共通の obligation と trigger は takos-control の
// `engineering.policy.json` → `deploy` が正本です。この repo は複数の surface を
// 持つので、surface 名を引数で選びます。
//
//   bun run deploy -- takosumi-website
//   bun run deploy -- takosumi-platform-staging plan ...
//   bun run deploy -- takosumi-platform plan ...
//   bun run deploy -- takosumi-platform-staging restore ...
//   bun run deploy -- takosumi-platform restore ...
//   bun run deploy -- takosumi-runner-image build ...
//   bun run deploy -- takosumi-runner-image reconcile ...
//   bun run deploy -- takosumi-runner-image verify ...
//
// `--contract` は副作用なしで、この repo が publish できる surface と、それぞれの
// trigger・義務の果たし方を印字します。takos-control の
// `scripts/check-deploy-contract.mjs` がそれを probe し、負う義務すべてに答えが
// あること、宣言した script/tool/env が実在することを確認します。
//
// `--lineage-selftest <corpusDir> <class>` は takos-control の lineage corpus に
// 対して、この repo が実際の deploy で使う lineage 関数そのものを走らせ、case ごと
// の verdict を一つの JSON document で印字します。副作用はありません。
//
// OSS platform worker の self-host deploy は利用者/operator自身のauthorityです。
// 公式 Takosumi も同じ OSS entry を operator-private config で実行します。

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import {
  isDeployLineageClass,
  requireCleanPushedSource,
  runLineageSelfTest,
} from "./lib/deploy-lineage.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const WEBSITE = {
  surface: "takosumi-website",
  project: "takosumi-website",
  productionBranch: "main",
  outputDir: "website/.output/public",
  site: "https://takosumi.com",
  build: ["bash", "website/build.sh"],
};

const PLATFORM_STAGING = {
  surface: "takosumi-platform-staging",
  environment: "staging",
  target: "cloudflare-worker:takosumi-staging",
};

const PLATFORM_PRODUCTION = {
  surface: "takosumi-platform",
  environment: "production",
  target: "cloudflare-worker:takosumi",
};

const CONTRACT_PACKAGE = {
  surface: "takosumi-contract-package",
  target: "npm:@takosjp/takosumi-contract",
};

// The runner image surface's DECLARATION only. Its implementation is imported
// lazily, in the branch that runs it: importing it here would hand every other
// surface — including the npm package publish — the capabilities of a
// Cloudflare container release it never uses.
const { RUNNER_IMAGE_RELEASE_CONTRACT_SURFACE } = await import(
  "./runner-image-release-contract.ts"
);

const platformContract = ({ surface, target, environment }) => ({
  surface,
  target,
  triggers: ["irreversible", "authority", "published-identity"],
  obligations: {
    provenance:
      `plan refuses a realized config that names a source path at all and reads the exact repository and commit identity from its sibling source pin, refuses to run from any checkout that is not that pinned repository and commit, then binds their canonical domain-separated source-authority digest into the confirmed plan together with the exact external realized ${environment} config digest, a twice-reproduced complete physical dashboard asset tree, an immutable Git source snapshot, the exact Wrangler dry-run output tree, metadata-only secret names, the exact 100 percent predecessor Version, and the exact healthy predecessor Container application identity and immutable image; ready evidence repeats the readable pin and digest, while execute and restore recheck their external sealed closures and copy them with stable no-follow reads into fresh single-link upload custody`,
    "post-conditions":
      "execute parses exactly one emitted Worker Version UUID, requires only that UUID at 100 percent, reads that immutable tagged Version back with the exact required bindings and fetch handler, proves the public root and Takosumi discovery document serve it, and requires exact Container list/detail identity, configured immutable image, no active rollout, and zero unhealthy instances; authenticated Hosted extension E2E is a separate required composition check",
    reversal:
      "the recorded plan names the exact source repository and commit plus their canonical authority digest, so the tree it was built from is re-materialized with `materialize-source` rather than depended on; the same reviewed owner surface exposes restore against the exact plan confirmation; it first uses the sealed image-only predecessor config with strict immediate rollout, then restores the exact predecessor Worker Version at 100 percent, and records exact public Version plus Container identity/image/health readback under a durable staged checkpoint; deleted Durable Object storage is forward-only and cannot be restored by code rollback",
    "failure-handling":
      "plan-derived external fsynced unknown checkpoints are durable immediately before forward upload and each restore stage and are shared by alternate evidence paths; malformed or torn checkpoints are post-touch ambiguity; bounded redacted provider diagnostics record pre-mutation, post-mutation-unknown, or post-mutation-readback failure; execute never uploads after any forward checkpoint, and bounded lost-ack recovery requires one unique post-plan tagged Version or remains incomplete",
    "pre-mutation-proof":
      `plan reads Cloudflare's metadata-only secret-name list, exact serving Version, and exact healthy Container list/detail state; it reproduces the environment-aware dashboard build twice and runs Wrangler dry-run with immediate Container rollout plus strict conflict checks for both the reviewed forward config and an image-only predecessor projection; the private plan seals every physical asset and dry-run output path, size, and digest with config, immutable source, secret-name-set, and predecessor identities`,
    "independent-review":
      "execute requires the exact plan confirmation and a named operator reviewer distinct from the source bytes",
    "no-overwrite":
      "Wrangler uploads the fresh custody copy of the exact sealed dry-run entry with --no-bundle and mints one new immutable Worker Version under a nonce-bound plan-unique recovery tag; custody is re-sealed before and after upload, and the owner binds its emitted UUID to exact 100 percent status and immutable Version readback before ready evidence",
  },
});

const CONTRACT = {
  kind: "takos.deploy-contract@v2",
  surfaces: [
    platformContract(PLATFORM_STAGING),
    platformContract(PLATFORM_PRODUCTION),
    RUNNER_IMAGE_RELEASE_CONTRACT_SURFACE,
    {
      surface: WEBSITE.surface,
      target: `cloudflare-pages:${WEBSITE.project}`,
      covers: ["website/wrangler.toml"],
      outputDir: WEBSITE.outputDir,
      // takosumi.com は landing + VitePress docs を重ねた prerendered な公開
      // バイト列だけです。durable state も server handler も target 側
      // credential も持たず、消費者が pin する identity も発行しません。
      triggers: [],
      lineage: "production-routine",
      obligations: {
        provenance: `requires the production-routine lineage class — a clean worktree on main, at or an ancestor of a freshly fetched origin/main — then builds ${WEBSITE.outputDir} with \`${WEBSITE.build.join(" ")}\` from that worktree, which is what validates these bytes since the landing and the VitePress docs both have to compile, scans the output for credential material, and records the commit and the index.html sha256. It deliberately does not run the repository-wide gate: the control-plane and runner suites cannot fail because of a documentation page, and gating a typo fix on them blocks publishing for reasons unrelated to what is being published.`,
        "post-conditions": `fetches the immutable deployment URL and ${WEBSITE.site}/ and requires both to serve the exact index.html digest just built, then requires ${WEBSITE.site}/docs/ to return 200`,
        reversal: `the previous production deployment id is read and printed before publishing; restore it with \`wrangler pages deployment list --project-name ${WEBSITE.project}\` and a rollback to that id`,
        "failure-handling":
          "prints the provider's own stdout and stderr, names whether the failure was before or after publication, and on a readback mismatch exits non-zero naming the previous deployment instead of retrying",
      },
    },
    {
      surface: CONTRACT_PACKAGE.surface,
      target: CONTRACT_PACKAGE.target,
      covers: ["contract", "scripts/contract-package-release.ts"],
      triggers: ["published-identity"],
      lineage: "published-identity",
      requiresScripts: ["check", "deploy"],
      requiresTools: ["git", "bun", "npm"],
      obligations: {
        provenance:
          "refuses a dirty or unpushed worktree, requires the package-scoped lightweight tag takosumi-contract-v<version> on the exact pushed source commit, runs the complete owner gate, packs once, records npm sha512 integrity, scans the tarball inventory, and installs those exact bytes into a fresh typechecked consumer before publication",
        "post-conditions":
          "reads the exact version and integrity back from npm, installs that registry identity into a fresh consumer, typechecks it, and executes public discovery, OIDC, and Interface imports",
        reversal:
          "npm package identities are immutable and cannot be rolled back in place; consumers can pin the previous version and a bad release is repaired only with a new patch version",
        "failure-handling":
          "distinguishes a failure before publication from an indeterminate attempted mutation, never retries blindly, and requires exact registry-integrity reconciliation before resuming",
        "no-overwrite":
          "publishes only an absent version; an existing identity is accepted solely when its registry integrity exactly matches the one prepared tarball",
      },
    },
  ],
};

if (process.argv.includes("--contract")) {
  process.stdout.write(`${JSON.stringify(CONTRACT, null, 2)}\n`);
  process.exit(0);
}

// Control's lineage corpus: run the function that guards the real deploy over
// seven materialized git states and print one verdict document. Side-effect
// free, and it reads nothing but the checkouts it is handed.
if (process.argv[2] === "--lineage-selftest") {
  const corpusRoot = process.argv[3];
  const lineageClass = process.argv[4];
  if (!corpusRoot || !lineageClass || !isDeployLineageClass(lineageClass)) {
    process.stderr.write(
      "usage: bun run deploy -- --lineage-selftest <corpusDir> <lineage-class>\n",
    );
    process.exit(1);
  }
  const { requiredContractReleaseTag } = await import(
    "./contract-package-release.ts"
  );
  const contractVersion = JSON.parse(
    readFileSync(join(repo, "contract/package.json"), "utf8"),
  ).version;
  process.stdout.write(
    `${JSON.stringify(
      await runLineageSelfTest(corpusRoot, lineageClass, {
        // The only identity this repository publishes as a git tag. No corpus
        // checkout carries it, which is why every case is refused for the
        // published-identity class — exactly what that class owes.
        tag:
          lineageClass === "published-identity"
            ? requiredContractReleaseTag(contractVersion)
            : null,
      }),
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

const requested = process.argv[2];
const known = CONTRACT.surfaces.map((entry) => entry.surface);
if (!requested || !known.includes(requested)) {
  process.stderr.write(
    `usage: bun run deploy -- <surface>\nknown surfaces: ${known.join(", ")}\n`,
  );
  process.exit(1);
}

const selected = requested;

function die(message, detail = []) {
  process.stderr.write(`deploy blocked: ${message}\n`);
  for (const line of detail) process.stderr.write(`- ${line}\n`);
  process.exit(1);
}

if (
  selected === PLATFORM_STAGING.surface ||
  selected === PLATFORM_PRODUCTION.surface
) {
  const { runPlatformWorkerRelease } =
    await import("./platform-worker-release.ts");
  const environment =
    selected === PLATFORM_STAGING.surface
      ? PLATFORM_STAGING.environment
      : PLATFORM_PRODUCTION.environment;
  await runPlatformWorkerRelease(process.argv.slice(3), environment);
  process.exit(0);
}

if (selected === RUNNER_IMAGE_RELEASE_CONTRACT_SURFACE.surface) {
  const runnerImageRelease = await import("./runner-image-release.ts");
  const options = runnerImageRelease.parseRunnerImageReleaseArgs(
    process.argv.slice(3),
  );
  const result = await runnerImageRelease.runRunnerImageRelease(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

if (selected === CONTRACT_PACKAGE.surface) {
  const { runContractPackageRelease } = await import("./contract-package-release.ts");
  await runContractPackageRelease(process.argv.slice(3));
  process.exit(0);
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

// provenance: 公開バイト列を一つの commit に結び付ける。takosumi.com は
// production-routine class で、clean な worktree だけでは足りない — その commit が
// fetch 済みの origin/main から実際に取得できることまで要求する。以前はここが
// dirty 判定だけで、このマシンにしか存在しない commit を公開できた。
try {
  await requireCleanPushedSource("production-routine", { cwd: repo });
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
const commit = git("rev-parse", "HEAD");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const subject = git("log", "-1", "--format=%s");
process.stdout.write(`source ${commit} (${branch})\n`);

// The build is the gate for these bytes. The landing and the docs both have to
// compile, and a broken page fails here. The repository-wide `bun run check`
// covers the control plane, the dashboard and the runner — none of which can be
// broken by a documentation change, and all of which would block one.
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
  if (
    /\.(?:png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf|mp4|pdf|wasm)$/u.test(name)
  )
    continue;
  for (const shape of CREDENTIAL_SHAPES) {
    if (shape.test(readFileSync(path, "utf8")))
      leaks.push(`${name}: matches ${shape}`);
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
    "pages",
    "deployment",
    "list",
    "--project-name",
    WEBSITE.project,
  ]);
  previous =
    listed.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/u,
    )?.[1] ?? null;
} catch (error) {
  die(`cannot read the current deployment list: ${error.message}`);
}
if (!previous) {
  die(
    "no previous production deployment was readable, so there is no revert point",
  );
}
process.stdout.write(`previous production deployment ${previous}\n`);

process.stdout.write(
  `\n==> publishing ${WEBSITE.outputDir} to ${WEBSITE.project}\n`,
);
let output;
try {
  output = run("wrangler", [
    "pages",
    "deploy",
    WEBSITE.outputDir,
    "--project-name",
    WEBSITE.project,
    "--branch",
    WEBSITE.productionBranch,
    "--commit-hash",
    commit,
    "--commit-message",
    subject,
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
    if (attempt < attempts)
      await new Promise((wake) => setTimeout(wake, 3000 * attempt));
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
