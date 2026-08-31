#!/usr/bin/env bun

// takosumi の唯一の deploy entrypoint です。
//
// 共通の obligation と trigger は takos-control の
// `engineering.policy.json` → `deploy` が正本です。この repo は複数の surface を
// 持つので、surface 名を引数で選びます。
//
//   bun run deploy -- takosumi-website
//   bun run deploy -- takosumi-control-d1-schema-staging plan ...
//   bun run deploy -- takosumi-control-d1-schema plan ...
//   bun run deploy -- takosumi-control-d1-bridge-proof-staging create ...
//   bun run deploy -- takosumi-control-d1-bridge-proof create ...
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
// あること、前回の snapshot から答えが変わっていないことを確認します。
//
// OSS platform worker の self-host deploy は利用者/operator自身のauthorityです。
// 公式 Takosumi も同じ OSS entry を operator-private config で実行します。

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

const CONTROL_D1_SCHEMA_STAGING = {
  surface: "takosumi-control-d1-schema-staging",
  environment: "staging",
  target: "cloudflare-d1:takosumi-control-staging",
};

const CONTROL_D1_SCHEMA_PRODUCTION = {
  surface: "takosumi-control-d1-schema",
  environment: "production",
  target: "cloudflare-d1:takosumi-control-production",
};

const CONTROL_D1_BRIDGE_PROOF_STAGING = {
  surface: "takosumi-control-d1-bridge-proof-staging",
  environment: "staging",
  target: "private-evidence:takosumi-control-d1-bridge-staging",
};

const CONTROL_D1_BRIDGE_PROOF_PRODUCTION = {
  surface: "takosumi-control-d1-bridge-proof",
  environment: "production",
  target: "private-evidence:takosumi-control-d1-bridge-production",
};

const CONTRACT_PACKAGE = {
  surface: "takosumi-contract-package",
  target: "npm:@takosjp/takosumi-contract",
};

const runnerImageRelease = await import("./runner-image-release.ts");

const platformContract = ({ surface, target, environment }) => ({
  surface,
  target,
  triggers: ["irreversible", "authority", "published-identity"],
  obligations: {
    provenance: `plan binds one clean pushed OSS commit, the exact external realized ${environment} config digest, a twice-reproduced complete physical dashboard asset tree, an immutable Git source snapshot, the exact Wrangler dry-run output tree, metadata-only secret names, the exact 100 percent predecessor Version, and the exact healthy predecessor Container application identity and immutable image; execute and restore recheck their external sealed closures and copy them with stable no-follow reads into fresh single-link upload custody`,
    "post-conditions":
      "execute parses exactly one emitted Worker Version UUID, requires only that UUID at 100 percent, reads that immutable tagged Version back with the exact required bindings and fetch handler, proves the public root and Takosumi discovery document serve it, and requires exact Container list/detail identity, configured immutable image, no active rollout, and zero unhealthy instances; authenticated Hosted extension E2E is a separate required composition check",
    reversal:
      "the same reviewed owner surface exposes restore against the exact full v5 plan confirmation only while that plan has not been retired by a forward-only control D1 transition; the complete plan validator binds environment, source, confirmation, checkpoint, and predecessor before the shared lock is derived, then restore rejects a durable schema-retirement marker before any Container or Worker mutation; otherwise it first uses the sealed image-only predecessor config with strict immediate rollout, restores the exact predecessor Worker Version at 100 percent, and reconciles every staged unknown checkpoint to exact readback before the schema owner may retire this restore; deleted Durable Object storage is forward-only and cannot be restored by code rollback",
    "failure-handling":
      "plan-derived external fsynced unknown checkpoints are durable immediately before forward upload and each restore stage and are shared by alternate evidence paths; malformed or torn checkpoints are post-touch ambiguity; bounded redacted provider diagnostics record pre-mutation, post-mutation-unknown, or post-mutation-readback failure; execute never uploads after any forward checkpoint, and bounded lost-ack recovery requires one unique post-plan tagged Version or remains incomplete",
    "pre-mutation-proof": `plan first read-only inspects the deterministic same-target owner under the explicit durable operator-private TAKOSUMI_PLATFORM_MUTATION_AUTHORITY_DIR and refuses active, unresolved, foreign, malformed, or torn authority before source/config/provider work; the plan seals that directory's canonical path and device/inode/birth-time/UID/mode identity digest; it then reads Cloudflare's metadata-only secret-name list, exact serving Version, and exact healthy Container list/detail state, reproduces the environment-aware dashboard build twice, and runs Wrangler dry-run with immediate Container rollout plus strict conflict checks for both the reviewed forward config and an image-only predecessor projection; execute, recovery, and restore bind the durable owner to operation kind plus exact plan confirmation and checkpoint path and hold it from their final serving/predecessor check through provider mutation and authoritative readback; a same-machine reboot permits only exact checkpoint/provider recovery, while a dead or unresolved owner rejects every new execute or different plan/kind; restore then acquires the plan-scoped authority lock and rejects a control-D1 schema-retirement marker before its first provider checkpoint`,
    "independent-review":
      "execute requires the exact plan confirmation and a named operator reviewer distinct from the source bytes",
    "no-overwrite":
      "Wrangler uploads the fresh custody copy of the exact sealed dry-run entry with --no-bundle and mints one new immutable Worker Version under a nonce-bound plan-unique recovery tag; custody is re-sealed before and after upload, and the owner binds its emitted UUID to exact 100 percent status and immutable Version readback before ready evidence",
  },
});

const controlD1SchemaContract = ({ surface, target, environment }) => ({
  surface,
  target,
  covers: [
    "worker/src/d1_opentofu_store.ts",
    "worker/src/d1_schema_maintenance.ts",
    "deploy/platform/control_d1_schema.ts",
    "deploy/platform/control_d1_schema_rest.ts",
    "deploy/platform/control_d1_bridge_challenge.ts",
    "scripts/control-d1-schema-release.ts",
  ],
  triggers: ["irreversible", "authority"],
  obligations: {
    provenance: `plan is read-only and binds one clean pushed OSS commit to the exact ${environment} account, database, currently serving bridge Worker Version, D1 binding and predeployed-bridge schema-mode binding, API-token identity digest, canonical manifest/schema/ledger digests, exact v66 predecessor ledger, sole v67 successor, a fresh Time Travel bookmark, and an official private reviewed compatibility proof for that immutable Version against the code-owned exact v66/v67 allowset; the proof producer and consumer both validate each complete takosumi.platform-worker-release-plan@v5 predecessor and bridge artifact, their accepted checkpoints and raw platform ready-evidence path/digest for each chain, prove that the predecessor evidence's deployed Version equals the bridge plan predecessor, derive both source commits from those artifacts, reject any local Git replace ref or graft, and with replacement objects disabled recompute the complete linear ordered Git compatibility closure with each commit parent, tree, changed paths and canonical full-index binary-patch digest plus a reviewer-bound aggregate digest rather than trusting a fixed path count, copied digest, or nonce/schema challenge; production consumes only genuine appliedMigrationVersions [67] staging execution evidence re-bound to its complete confirmed plan, source-compatibility digest, accepted mutation checkpoint, raw pre/post challenges, durable maintenance-release receipt whose release-readiness digest binds the plan confirmation, source compatibility and pre-apply checkpoint record, exact live D1 readback and fresh v67 challenge, never observed-ready adoption, and rejects either the same physical account/database tuple or the same secret-free token-custody digest, while raw tokens never enter plans, receipts, evidence, diagnostics, or stdout`,
    "post-conditions":
      "execute requires the proof-bound compatible bridge Version to remain the sole serving Version, durably retires that bridge plan's v66-only predecessor restore before schema mutation, applies only migration [67], then independently reads the plan/checkpoint-bound durable release receipt and exact ready v67 schema and challenges the same Version against the physical v67 ledger before accepting the checkpoint: 64 immutable ledger rows, 38 OSS tables, and the planned manifest, schema, and ledger digests; inactive is safe only because the live bridge proves the code-owned exact v66/v67 allowset",
    reversal:
      "schema migration is forward-only: before apply the surface permanently retires the exact bridge deployment plan's v66-only predecessor restore under that plan's restore lock, and the compatible bridge remains the Worker rollback floor through candidate readback; recover only reports ready or releases an exact matching active in-place fence after rechecking the retained proof, live bridge Version and D1 binding and ensuring the same stale restore remains retired; D1 Time Travel restore is a separate incident authority that this surface never invokes",
    "failure-handling":
      "a plan-derived fsynced mutation checkpoint prevents a second apply through another evidence path; the shared target-scoped lock excludes every official platform forward/restore mutation while schema can change or certify v67, durably binds the exact schema plan/checkpoint, and after process death or post-checkpoint failure permits only that plan's recover while rejecting every new execute or different plan/kind; under the validated bridge restore lock execute and v67 recovery reject every malformed, partial, or unknown platform restore checkpoint and require official restore reconciliation before retirement, apply, or ready evidence; execute invokes the existing apply once, never blind-retries, and every recovery reads authoritative ledger/fence/schema state before deciding untouched, ready, reviewed fence release, or fail-closed Time Travel escalation",
    "pre-mutation-proof":
      "the real schema plan first read-only inspects the deterministic owner under the same explicit durable operator-private target authority used by platform, seals its canonical path and directory inode-identity digest, and refuses unresolved/foreign/malformed state before source, provider, or D1 reads; plan and execute use the explicit account-scoped Cloudflare API-token REST boundary to recheck the exact proof-bound serving bridge Version, Worker D1 target and predeployed-bridge schema-mode binding, unchanged proof, raw platform plan, and raw platform ready evidence, complete validator-accepted v5 bridge plan, nonce-bound physical-ledger challenges, exact predecessor schema/ledger, absent fence, clean pushed source, credential digest, bookmark, and for production a genuine execution receipt with distinct target and credential custody that is independently re-bound to its staging plan/checkpoint/live readback/release receipt; one canonical-path and existing-inode graph covers both schema plans/evidence/checkpoints/proofs/raw platform evidence/receipt plus the platform artifacts and both sealed closure trees, including absent future aliases; execute and every recovery branch that can reconcile the exact schema owner acquire the same target-scoped lock used by platform forward and restore, with target then plan-lock order; each v67 branch requires no unresolved restore checkpoint and spans final checks, retirement, sole apply or reviewed fence release, exact readback, and ready evidence",
    "independent-review":
      "execute requires the exact private-plan confirmation and a named operator reviewer distinct from the source author; recovery fence release requires its own state-derived confirmation and the same independent-review rule",
  },
});

const controlD1BridgeProofContract = ({ surface, target, environment }) => ({
  surface,
  target,
  covers: [
    "scripts/platform-worker-release.ts",
    "scripts/control-d1-schema-release.ts",
    "deploy/platform/control_d1_schema.ts",
    "deploy/platform/control_d1_bridge_challenge.ts",
    "deploy/platform/entry-worker.ts",
    "worker/src/d1_opentofu_store.ts",
  ],
  triggers: ["authority"],
  obligations: {
    provenance: `the read-only producer accepts only complete validated v5 ${environment} predecessor and bridge plans, their exact accepted forward checkpoints, and both complete single-link 0600 platform ready-evidence artifacts; the predecessor evidence's deployed Version must equal the bridge plan's predecessor Version, both plans must share the exact target-mutation authority, both source commits come only from validated artifacts, and Git with replacement objects disabled must prove the complete linear ordered descendant closure with every commit's single parent, tree, changed paths and canonical full-index binary-patch digest plus one reviewer-bound aggregate digest while any local replace ref or graft fails closed; it also binds the live immutable Worker Version for the bridge, control-D1 binding, predeployed-bridge schema-mode binding, code-owned exact v66/v67 catalog and cache-free nonce-bound physical-v66-ledger challenge`,
    "post-conditions":
      "writes exactly one absent single-link mode-0600 private takosumi.control-d1-serving-compatibility-proof@v3 whose confirmation covers every retained authority, ordered source closure and raw canonical challenge response/digest; the schema consumer rereads the raw platform evidence and both complete release chains, then recomputes every Git closure edge rather than trusting copied digests, while exact v66 bridge runtime disables Interface-bearing or sealed Plan sidecars and Interface intent writes before Apply/provider mutation, keeps authenticated InstallConfig re-adoption on its table-free exact-ledger CAS path, and exact v67 enables tested Interface commit/read while atomically retiring unresolved intents during re-adoption",
    reversal:
      "this producer performs no provider or D1 mutation; an unused private proof may be discarded, while any schema plan that consumed its exact path/digest remains immutable and requires a new plan",
    "failure-handling":
      "malformed, incomplete, aliased, wrong-environment, non-serving, wrong-binding, non-bridge-mode, wrong-nonce, stale/cached, v66-only-allowset, wrong-physical-ledger, wrong predecessor Version/source, Git replace/graft substitution, missing/reordered/additional/merge descendant, parent/tree/path/patch drift, copied closure digest, reviewer mismatch, or unresolved-target input fails before proof creation and never fabricates compatibility from a Version ID, schema challenge, fixed path list, or hand-authored JSON",
    "pre-mutation-proof":
      "before its sole private artifact write it read-only checks the durable same-target authority, both complete plan/checkpoint/evidence chains, predecessor-to-bridge ordered source closure and every canonical patch edge, exact live REST Version and bindings, and canonical source-owned v66/v67 ledgers; API tokens and raw target IDs stay out of stdout",
    "independent-review":
      "the proof requires an explicit reviewer and compatibility-closure confirmation matching the recomputed reviewer-bound aggregate and the named independent reviewer from validator-accepted bridge ready evidence; that reviewer cannot be any closure commit author and no new or copied review identity can be substituted",
  },
});

const CONTRACT = {
  kind: "takos.deploy-contract@v2",
  surfaces: [
    controlD1BridgeProofContract(CONTROL_D1_BRIDGE_PROOF_STAGING),
    controlD1BridgeProofContract(CONTROL_D1_BRIDGE_PROOF_PRODUCTION),
    controlD1SchemaContract(CONTROL_D1_SCHEMA_STAGING),
    controlD1SchemaContract(CONTROL_D1_SCHEMA_PRODUCTION),
    platformContract(PLATFORM_STAGING),
    platformContract(PLATFORM_PRODUCTION),
    runnerImageRelease.RUNNER_IMAGE_RELEASE_CONTRACT_SURFACE,
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
      surface: CONTRACT_PACKAGE.surface,
      target: CONTRACT_PACKAGE.target,
      covers: ["contract", "scripts/contract-package-release.ts"],
      triggers: ["published-identity"],
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
  selected === CONTROL_D1_BRIDGE_PROOF_STAGING.surface ||
  selected === CONTROL_D1_BRIDGE_PROOF_PRODUCTION.surface
) {
  const { runControlD1ServingCompatibilityProof } =
    await import("./control-d1-schema-release.ts");
  const environment =
    selected === CONTROL_D1_BRIDGE_PROOF_STAGING.surface
      ? CONTROL_D1_BRIDGE_PROOF_STAGING.environment
      : CONTROL_D1_BRIDGE_PROOF_PRODUCTION.environment;
  await runControlD1ServingCompatibilityProof(
    process.argv.slice(3),
    environment,
  );
  process.exit(0);
}

if (
  selected === CONTROL_D1_SCHEMA_STAGING.surface ||
  selected === CONTROL_D1_SCHEMA_PRODUCTION.surface
) {
  const { runControlD1SchemaRelease } =
    await import("./control-d1-schema-release.ts");
  const environment =
    selected === CONTROL_D1_SCHEMA_STAGING.surface
      ? CONTROL_D1_SCHEMA_STAGING.environment
      : CONTROL_D1_SCHEMA_PRODUCTION.environment;
  await runControlD1SchemaRelease(process.argv.slice(3), environment);
  process.exit(0);
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

if (
  selected === runnerImageRelease.RUNNER_IMAGE_RELEASE_CONTRACT_SURFACE.surface
) {
  const options = runnerImageRelease.parseRunnerImageReleaseArgs(
    process.argv.slice(3),
  );
  const result = await runnerImageRelease.runRunnerImageRelease(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

if (selected === CONTRACT_PACKAGE.surface) {
  const { runContractPackageRelease } =
    await import("./contract-package-release.ts");
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
