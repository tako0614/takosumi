import { expect, test } from "bun:test";
import { runLiveOpenTofuPlanApplyProof } from "../proofs/live-opentofu-plan-apply.ts";

const hasTofu = await commandExists("tofu");

test.skipIf(!hasTofu)(
  "live local proof executes tofu plan/apply and records Output projection",
  async () => {
    const proof = await runLiveOpenTofuPlanApplyProof({
      now: () => "2026-06-02T00:00:00.000Z",
    });

    expect(proof.kind).toBe("takosumi.live-local-opentofu-plan-apply-proof@v1");
    expect(proof.status).toBe("passed");
    expect(proof.evidence.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(proof.evidence.outputCount).toBeGreaterThan(0);
    expect(proof.evidence.stateLockStatus).toBe("recorded");
    expect(proof.evidence.applyAuditEventCount).toBeGreaterThan(0);
    expect(proof.evidence.providerSource).toBe(
      "registry.opentofu.org/hashicorp/local",
    );
    expect(proof.evidence.destroyStatus).toBe("succeeded");
    expect(proof.evidence.resourceRemoved).toBe(true);
  },
);

async function commandExists(command: string): Promise<boolean> {
  const proc = Bun.spawn(["bash", "-lc", `command -v ${command}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return await proc.exited === 0;
}
