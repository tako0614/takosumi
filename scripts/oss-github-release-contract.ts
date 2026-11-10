/** Declaration only: contract discovery never loads publication capabilities. */
export const OSS_GITHUB_RELEASE_CONTRACT_SURFACE = {
  surface: "takosumi-oss-github-release",
  target: "github-release:tako0614/takosumi",
  triggers: ["published-identity"],
  covers: ["scripts/oss-github-release.ts", "package.json", "CHANGELOG.md", "docs/releases"],
  requiresTools: ["bun", "git", "gh"],
  obligations: {
    provenance: "publishes one clean exact current origin/main commit whose root version matches the selected stable tag and whose existing GitHub main quality run completed every required job; reads notes from that immutable source and never repeats the owner gate",
    "post-conditions": "fetches the exact published annotated tag without fetching other tags, verifies its configured trusted signature, internal version name and exact commit, and reads the non-draft GitHub Release back with matching tag and notes digest and no assets",
    reversal: "never moves or removes a published identity; halt promotion and repair through a new reviewed version; runtime rollback and database restore remain separate operator decisions",
    "failure-handling": "refuses uncertain preflight reads; any attempted signing or publication failure is indeterminate and prints the last stage; verify only reads the selected identity and never retries a mutation",
    "no-overwrite": "requires both local and remote tag and GitHub Release to be absent before first publication; uses non-force tag push and create-only Release POST; no edit, clobber, delete, or automatic resume",
  },
} as const;
