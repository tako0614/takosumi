/**
 * The runner image release surface's DECLARATION, separated from its
 * implementation.
 *
 * WHY they are separate files. `scripts/deploy.mjs` has to print every
 * surface's contract eagerly, so it used to import the whole release module at
 * module scope — and takos-control's requiresEnv gate, which walks what each
 * surface's declared scripts can reach, therefore attributed this release's
 * `CLOUDFLARE_ACCOUNT_ID` read to every other surface in the repository,
 * including the npm package publish that never touches Cloudflare. A contract
 * is data; a release is code. Importing the data does not drag the code's
 * capabilities along with it.
 */
export const RUNNER_IMAGE_RELEASE_CONTRACT_SURFACE = {
  surface: "takosumi-runner-image",
  target: "cloudflare-container:takosumi-runner",
  covers: [
    "runner/Dockerfile",
    "runner",
    "scripts/lib/platform-release-source.ts",
    "scripts/runner-image-release.ts",
  ],
  triggers: ["authority", "published-identity"],
  requiresScripts: ["check", "deploy"],
  requiresTools: ["git", "bun", "docker", "wrangler", "tar", "curl", "cosign"],
  requiresEnv: ["CLOUDFLARE_ACCOUNT_ID"],
  obligations: {
    provenance:
      "build, reconciliation, and verification require an identity-only realized config with no main or assets directory plus its stable single-link sibling source pin, and require that exact Git repository and commit to be the clean attached pushed checkout; one canonical domain-separated digest of the exact pin kind, repository, and commit is carried through the publication journal, build evidence, confirmed platform plan, and ready evidence; staging requires HEAD to equal both local and freshly read remote origin/current-branch while production additionally requires main; runner paths are derived only in an ephemeral projection from that pinned checkout while the pathless config bytes remain the evidence identity; build materializes the immutable Git commit in an external sealed context, verifies the Dockerfile-pinned OpenTofu artifact through its upstream Sigstore identity, and binds the exact image-only activation transform plus publication journal to the remotely read content digest; reconciliation accepts only a no-replace-object historical attempt commit from the same repository that is an ancestor of the trusted current tool and fresh remote tip, then re-materializes and seals that exact commit; verification requires build activation authority, platform ready authority, and the freshly resolved sibling-pin authority to be identical before live readback, and binds recovered records to their explicit reconciledBy tool identity",
    "post-conditions":
      "build records the local Docker image ID and an explicit Descriptor digest with exact supported manifest media type and linux/amd64 platform, accepts only Docker's unambiguous remote Descriptor.platform linux/amd64 shape, and requires exact local/remote descriptor-digest equality before recording that immutable descriptor digest as the sole consumer identity and the actual config digest as evidence; a legacy attempt without the explicit descriptor field additionally requires the exact recorded local tag to remain present with both Docker Id and Descriptor equal to the legacy value; verification requires the platform evidence Worker Version to be exactly serving at 100 percent and the exact environment Container application to be healthy on that digest",
    reversal:
      "build evidence retains the exact previous immutable digest; rollback changes only the realized image literal back to that retained digest, passes through a new reviewed platform plan and execute, and verifies it",
    "failure-handling":
      "the executing account is CLOUDFLARE_ACCOUNT_ID and must equal the realized prior-image repository, whose exact target and environment select one external locator bound to a single physical machine/PID namespace and exact journal inode; a complete boot/PID-start/file-identity lock record is fsynced in a private pending inode before atomic no-overwrite publication, foreign host/namespace/boot locks are never reclaimed, and the locked operation holds and revalidates the same locator and journal descriptors immediately before push; the journal and containing directory are fsynced before push, a missing or replaced journal fails closed, and every unresolved unknown blocks every later build until explicit read-only reconciliation proves the exact recorded tag present with matching image bytes or authoritatively absent; this is deliberately local-host authority, not a distributed lock, so shared state across operator hosts is refused; bounded redacted evidence distinguishes pre-mutation failure from post-mutation unknown; verification performs no Worker mutation and fails on platform evidence, config, serving Version, application identity, image, rollout, or health ambiguity",
    "independent-review":
      "executing build or verification requires a named --review value; verification additionally consumes the platform release reviewer and sealed plan evidence",
    "no-overwrite":
      "the source/content/nonce-bound mutable transport tag is never a version identity or consumer input and is not protected by a racy check-then-push claim; the published identity is the content-addressed sha256 descriptor digest, whose exact manifest bytes are bound through local/remote descriptor-digest equality, and verification consumes exactly one matching immutable-digest build record",
  },
} as const;
