/**
 * Emits the two `takosumi.opentofu-run@v1` dispatch envelopes (plan, then apply)
 * that the production OpenTofuRunnerObject DO sends to the runner container's
 * `POST /runs/{runId}` route, using the REAL rootgen generator + the REAL `core`
 * template catalog entry. No cloud credentials are involved: `core` is a pure
 * value-plumbing module (no providers).
 *
 * The DO's `parseRunEnvelope` reads only `{ action, request }` off the body; the
 * runner's `handleRunnerRequest` reads `body.action` and `body.request`. We emit
 * the full envelope shape `{ kind, action, runId, requestedAt, request }` so the
 * payload matches what the DO actually serializes.
 *
 * Usage:
 *   bun run scripts/prove-runner-docker-payload.ts plan  <runId>
 *   bun run scripts/prove-runner-docker-payload.ts apply <runId> <planDigest>
 *
 * Prints a single JSON object (the envelope) to stdout.
 */

import { generateInstallationRoot } from "takosumi-rootgen";
import { coreTemplate } from "../opentofu-modules/core/template.ts";

const ENVELOPE_KIND = "takosumi.opentofu-run@v1";

// The baked official-template reference the runner copies to
// /work/generated-root/template-module. `localModulePath` must live under
// /app/templates (asserted by the runner's parseTemplate); the core module is
// baked at /app/templates/core/module by the Dockerfile (COPY opentofu-modules/
// -> ./templates/).
const TEMPLATE_REF = {
  id: coreTemplate.id,
  version: coreTemplate.version,
  localModulePath: "/app/templates/core/module",
} as const;

// Real, validated template inputs. base_domain is required (see core template.ts
// / module/main.tf); display_name is optional.
const INPUTS = {
  base_domain: "proof.example.com",
  display_name: "Runner Docker Proof",
} as const;

function generatedRootFiles(): Record<string, string> {
  const generated = generateInstallationRoot({
    template: coreTemplate,
    inputs: INPUTS,
    installType: "core",
  });
  return generated.files as Record<string, string>;
}

function planEnvelope(runId: string): unknown {
  return {
    kind: ENVELOPE_KIND,
    action: "plan",
    runId,
    requestedAt: new Date().toISOString(),
    request: {
      template: TEMPLATE_REF,
      generatedRoot: { files: generatedRootFiles() },
      planRun: { operation: "create" },
    },
  };
}

function applyEnvelope(runId: string, planDigest: string): unknown {
  return {
    kind: ENVELOPE_KIND,
    action: "apply",
    runId,
    requestedAt: new Date().toISOString(),
    request: {
      template: TEMPLATE_REF,
      generatedRoot: { files: generatedRootFiles() },
      // For a runner-local plan artifact the apply only needs the plan digest:
      // the runner verifies the still-warm /work/<runId>/tfplan against this
      // digest and runs `tofu apply tfplan` against the restored generated root.
      planArtifact: { kind: "runner-local", digest: planDigest },
    },
  };
}

function main(): void {
  const [mode, runId, planDigest] = process.argv.slice(2);
  if (!mode || !runId) {
    console.error(
      "usage: prove-runner-docker-payload.ts <plan|apply> <runId> [planDigest]",
    );
    process.exit(2);
  }
  if (mode === "plan") {
    process.stdout.write(JSON.stringify(planEnvelope(runId)));
    return;
  }
  if (mode === "apply") {
    if (!planDigest) {
      console.error("apply mode requires a planDigest argument");
      process.exit(2);
    }
    process.stdout.write(JSON.stringify(applyEnvelope(runId, planDigest)));
    return;
  }
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

main();
