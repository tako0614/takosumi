/**
 * One lineage predicate for every Takosumi deploy surface.
 *
 * WHY this exists. Four surfaces answered "which source am I publishing" four
 * different ways, and the weakest of them published takosumi.com behind a
 * clean-worktree check alone — which accepts a commit that exists nowhere but
 * the operator's machine. `deploy.obligations.provenance` requires the answer;
 * nothing could check whether it was true, because each surface's answer lived
 * in its own function and no two agreed.
 *
 * The classes and their predicates are takos-control's
 * `engineering.policy.json` → `deploy.lineage`. This module implements them
 * once; a surface picks a class and may only *tighten* it. Control proves the
 * implementation rather than reading the claim: `scripts/lib/lineage-corpus.mjs`
 * materializes seven real git checkouts, `bun run deploy -- --lineage-selftest
 * <corpusDir> <class>` runs THIS function over each of them, and
 * `check-deploy-lineage.mjs` diffs the verdicts against the policy table.
 *
 * The predicate deliberately decides from the checkout it is handed and
 * nothing else: control runs the self-test under a scrubbed environment, so a
 * lineage answer that depended on ambient operator or CI state would be caught.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEPLOY_LINEAGE_CLASSES = [
  "integration",
  "rehearsal",
  "production-routine",
  "published-identity",
] as const;

export type DeployLineageClass = (typeof DEPLOY_LINEAGE_CLASSES)[number];

/**
 * Why a source was refused, as a machine value.
 *
 * A caller that already has its own error vocabulary maps this instead of
 * matching on prose; a caller that does not prints `why`.
 */
export type LineageRefusal =
  | "not-a-checkout"
  | "dirty-worktree"
  | "detached-head"
  | "not-default-branch"
  | "remote-unknown"
  | "unreachable-from-origin"
  | "no-tag-named"
  | "tag-absent-on-origin"
  | "tag-not-at-head";

export type LineageVerdict = Readonly<{
  verdict: "accept" | "refuse";
  why: string;
  reason?: LineageRefusal;
}>;

/**
 * Injectable git, so a caller that already owns a command seam (the runner
 * image release) uses the same predicate instead of a second copy of it.
 * Returns trimmed stdout, or `null` when git failed.
 */
export type LineageGit = (
  args: readonly string[],
  cwd: string,
) => Promise<string | null>;

export interface LineageOptions {
  readonly cwd: string;
  /** The tag a `published-identity` surface is about to mint. */
  readonly tag?: string | null;
  readonly defaultBranch?: string;
  readonly git?: LineageGit;
}

const defaultGit: LineageGit = async (args, cwd) => {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch {
    return null;
  }
};

/**
 * May a deploy of `lineageClass` proceed from this checkout?
 *
 *   integration / rehearsal  any source. A dirty worktree is the point of an
 *                            integration deploy, and constraining a rehearsal
 *                            only pushes it out of the loop.
 *   production-routine       clean worktree, on the default branch, HEAD equal
 *                            to or an ancestor of a freshly fetched
 *                            origin/<default>. Equal-OR-ancestor, not plain
 *                            ancestry: plain ancestry would relax the surfaces
 *                            that already demand equality, while an explicitly
 *                            named older commit is a legitimate rollback.
 *   published-identity       production-routine, plus the tag being published
 *                            already exists on origin at that commit. A tag
 *                            that exists only locally mints an identity nobody
 *                            can re-obtain, and every worktree-shaped check in
 *                            the workspace calls that source clean.
 */
export async function lineageVerdict(
  lineageClass: DeployLineageClass,
  options: LineageOptions,
): Promise<LineageVerdict> {
  if (lineageClass === "integration" || lineageClass === "rehearsal") {
    return {
      verdict: "accept",
      why: "any source is admissible in this environment",
    };
  }
  const cwd = options.cwd;
  const git = options.git ?? defaultGit;
  const defaultBranch = options.defaultBranch ?? "main";

  const status = await git(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd,
  );
  if (status === null) return { verdict: "refuse", why: "not a git checkout", reason: "not-a-checkout" };
  if (status.length > 0) {
    return {
      verdict: "refuse",
      why: "the worktree is not clean; the published bytes belong to no commit",
      reason: "dirty-worktree",
    };
  }

  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
  if (branch === null || branch.length === 0) {
    return {
      verdict: "refuse",
      why: "HEAD is detached; nothing names what was built",
      reason: "detached-head",
    };
  }
  if (branch !== defaultBranch) {
    return {
      verdict: "refuse",
      why: `on ${branch}, not the default branch ${defaultBranch}`,
      reason: "not-default-branch",
    };
  }

  // Fetch first. `git branch -r --contains` and a stale remote-tracking ref
  // both vouch for a commit the remote no longer has.
  await git(["fetch", "--quiet", "origin", defaultBranch], cwd);
  const remote = await git(
    ["rev-parse", "--verify", `refs/remotes/origin/${defaultBranch}`],
    cwd,
  );
  if (remote === null || remote.length === 0) {
    return {
      verdict: "refuse",
      why: `origin/${defaultBranch} is unknown; this source is unobtainable`,
      reason: "remote-unknown",
    };
  }
  const head = await git(["rev-parse", "HEAD"], cwd);
  if (head === null || head.length === 0) {
    return {
      verdict: "refuse",
      why: "HEAD does not resolve",
      reason: "not-a-checkout",
    };
  }
  const reachable =
    head === remote ||
    (await git(["merge-base", "--is-ancestor", head, remote], cwd)) !== null;
  if (!reachable) {
    return {
      verdict: "refuse",
      why: `HEAD is neither origin/${defaultBranch} nor an ancestor of it; nobody else can obtain this source`,
      reason: "unreachable-from-origin",
    };
  }

  if (lineageClass === "production-routine") {
    return {
      verdict: "accept",
      why: `clean, on ${defaultBranch}, reachable from origin at ${head}`,
    };
  }

  const tag = options.tag ?? null;
  if (!tag) {
    return {
      verdict: "refuse",
      why: "no tag named; a published identity must exist as a tag on origin",
      reason: "no-tag-named",
    };
  }
  const remoteTag = await git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`], cwd);
  if (remoteTag === null || remoteTag.length === 0) {
    return {
      verdict: "refuse",
      why: `tag ${tag} does not exist on origin`,
      reason: "tag-absent-on-origin",
    };
  }
  const resolved = remoteTag.split("\n")[0]?.split(/\s+/u)[0] ?? "";
  const peeled = await git(["rev-parse", `${tag}^{commit}`], cwd);
  if (resolved !== head && peeled !== head) {
    return {
      verdict: "refuse",
      why: `tag ${tag} on origin does not point at HEAD`,
      reason: "tag-not-at-head",
    };
  }
  return { verdict: "accept", why: `tag ${tag} exists on origin at ${head}` };
}

export class DeployLineageError extends Error {
  constructor(
    readonly lineageClass: DeployLineageClass,
    readonly why: string,
  ) {
    super(`deploy blocked: lineage ${lineageClass} refused this source: ${why}`);
    this.name = "DeployLineageError";
  }
}

/**
 * The guard a real deploy calls. Same function the corpus self-test runs, so a
 * green self-test is evidence about the code that actually deploys.
 */
export async function requireCleanPushedSource(
  lineageClass: DeployLineageClass,
  options: LineageOptions,
): Promise<void> {
  const answer = await lineageVerdict(lineageClass, options);
  if (answer.verdict !== "accept") {
    throw new DeployLineageError(lineageClass, answer.why);
  }
}

export type LineageSelfTestDocument = Readonly<{
  kind: "takos.lineage-corpus@v1";
  lineage: DeployLineageClass;
  verdicts: Readonly<Record<string, "accept" | "refuse">>;
}>;

export function isDeployLineageClass(
  value: string,
): value is DeployLineageClass {
  return (DEPLOY_LINEAGE_CLASSES as readonly string[]).includes(value);
}

/**
 * Answer control's lineage corpus.
 *
 * Each case is `<corpusRoot>/<caseId>/checkout`. The tag asked about for the
 * `published-identity` class is this repository's own release-tag shape, which
 * no corpus checkout carries — so every case is refused, which is exactly what
 * the policy table says a published identity owes.
 */
export async function runLineageSelfTest(
  corpusRoot: string,
  lineageClass: DeployLineageClass,
  options: { readonly tag?: string | null } = {},
): Promise<LineageSelfTestDocument> {
  const verdicts: Record<string, "accept" | "refuse"> = {};
  for (const entry of readdirSync(corpusRoot).sort()) {
    const checkout = join(corpusRoot, entry, "checkout");
    let isCheckout = false;
    try {
      isCheckout = statSync(checkout).isDirectory();
    } catch {
      isCheckout = false;
    }
    if (!isCheckout) continue;
    const answer = await lineageVerdict(lineageClass, {
      cwd: checkout,
      tag: options.tag ?? null,
    });
    verdicts[entry] = answer.verdict;
  }
  return {
    kind: "takos.lineage-corpus@v1",
    lineage: lineageClass,
    verdicts,
  };
}
