import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  DEPLOY_LINEAGE_CLASSES,
  lineageVerdict,
  requireCleanPushedSource,
  runLineageSelfTest,
} from "../../scripts/lib/deploy-lineage.ts";

/**
 * The authoritative verdict table is takos-control's lineage corpus, and
 * `check-deploy-lineage.mjs` diffs this repository's `--lineage-selftest`
 * answers against it. Restating that table here would be a second copy of the
 * rule, so these tests cover what the control gate cannot reach: that the
 * predicate is executed against a real checkout rather than a claim, that the
 * refusal carries a machine reason, and that the self-test emits the wire shape.
 */

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  }).trim();
}

function materialize(): { root: string; checkout: string } {
  const root = mkdtempSync(resolve(tmpdir(), "takosumi-lineage-"));
  const bare = resolve(root, "origin.git");
  const checkout = resolve(root, "checkout");
  git(["init", "-q", "--bare", "--initial-branch=main", bare], root);
  git(["init", "-q", "--initial-branch=main", checkout], root);
  git(["remote", "add", "origin", bare], checkout);
  writeFileSync(resolve(checkout, "README.md"), "base\n");
  git(["add", "-A"], checkout);
  git(["commit", "-q", "-m", "base"], checkout);
  git(["push", "-q", "origin", "main"], checkout);
  git(["fetch", "-q", "origin"], checkout);
  return { root, checkout };
}

test("production-routine accepts a clean pushed default branch and names why", async () => {
  const { root, checkout } = materialize();
  try {
    const answer = await lineageVerdict("production-routine", { cwd: checkout });
    expect(answer.verdict).toBe("accept");
    expect(answer.reason).toBeUndefined();
    await expect(
      requireCleanPushedSource("production-routine", { cwd: checkout }),
    ).resolves.toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a commit that exists only on this machine is refused with a machine reason", async () => {
  const { root, checkout } = materialize();
  try {
    writeFileSync(resolve(checkout, "ahead.txt"), "ahead\n");
    git(["add", "-A"], checkout);
    git(["commit", "-q", "-m", "ahead"], checkout);

    const answer = await lineageVerdict("production-routine", { cwd: checkout });
    expect(answer.verdict).toBe("refuse");
    expect(answer.reason).toBe("unreachable-from-origin");
    // The defect this closes: a clean-worktree check calls this source clean.
    expect(git(["status", "--porcelain"], checkout)).toBe("");

    await expect(
      requireCleanPushedSource("production-routine", { cwd: checkout }),
    ).rejects.toThrow("lineage production-routine refused this source");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tag that exists only locally cannot mint a published identity", async () => {
  const { root, checkout } = materialize();
  try {
    git(["tag", "v9.9.9"], checkout);
    expect(
      (await lineageVerdict("production-routine", { cwd: checkout })).verdict,
    ).toBe("accept");
    const answer = await lineageVerdict("published-identity", {
      cwd: checkout,
      tag: "v9.9.9",
    });
    expect(answer.verdict).toBe("refuse");
    expect(answer.reason).toBe("tag-absent-on-origin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the self-test answers every corpus case in the published wire shape", async () => {
  const corpusRoot = mkdtempSync(resolve(tmpdir(), "takosumi-lineage-corpus-"));
  try {
    for (const id of ["clean", "dirty"]) {
      const caseRoot = resolve(corpusRoot, id);
      const bare = resolve(caseRoot, "origin.git");
      const checkout = resolve(caseRoot, "checkout");
      git(["init", "-q", "--bare", "--initial-branch=main", bare], corpusRoot);
      git(["init", "-q", "--initial-branch=main", checkout], corpusRoot);
      git(["remote", "add", "origin", bare], checkout);
      writeFileSync(resolve(checkout, "README.md"), "base\n");
      git(["add", "-A"], checkout);
      git(["commit", "-q", "-m", "base"], checkout);
      git(["push", "-q", "origin", "main"], checkout);
      git(["fetch", "-q", "origin"], checkout);
      if (id === "dirty") {
        writeFileSync(resolve(checkout, "README.md"), "modified\n");
      }
    }
    const document = await runLineageSelfTest(corpusRoot, "production-routine");
    expect(document.kind).toBe("takos.lineage-corpus@v1");
    expect(document.lineage).toBe("production-routine");
    expect(document.verdicts).toEqual({ clean: "accept", dirty: "refuse" });
  } finally {
    rmSync(corpusRoot, { recursive: true, force: true });
  }
});

test("every surface that declares a lineage class declares a known one", async () => {
  const contract = JSON.parse(
    execFileSync("bun", ["run", "--silent", "deploy", "--", "--contract"], {
      cwd: resolve(import.meta.dir, "../.."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  ) as {
    readonly surfaces: readonly {
      readonly surface: string;
      readonly lineage?: string;
    }[];
  };
  const declared = contract.surfaces.filter((surface) => surface.lineage);
  expect(declared.length).toBeGreaterThan(0);
  for (const surface of declared) {
    expect(DEPLOY_LINEAGE_CLASSES).toContain(surface.lineage);
  }
});
