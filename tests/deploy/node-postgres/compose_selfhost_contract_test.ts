/**
 * Contract tests for the promoted Bun + PostgreSQL self-host compose file:
 * the published `docker compose up` path must actually deliver the secrets
 * the service requires and the OpenTofu runner that makes it an app platform.
 * These read the compose file as text/structure — no docker needed.
 */
import { expect, test } from "bun:test";

const composePath = new URL(
  "../../../deploy/node-postgres/docker-compose.yml",
  import.meta.url,
);
const envExamplePath = new URL(
  "../../../deploy/node-postgres/.env.example",
  import.meta.url,
);

async function composeText(): Promise<string> {
  return await Bun.file(composePath).text();
}

test("compose passes every required service secret through to accounts", async () => {
  const text = await composeText();
  for (const name of [
    "TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK",
    "TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS",
    "TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET",
    "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT",
    "TAKOSUMI_SECRET_STORE_PASSPHRASE",
    "TAKOSUMI_DEPLOY_CONTROL_TOKEN",
  ]) {
    // `${VAR:-}` (optional) so the service's own fail-closed https-issuer
    // check produces the actionable error, never a bare compose failure.
    expect(text).toContain(`${name}: \${${name}:-}`);
  }
});

test("compose ships the OpenTofu runner and wires the service to it", async () => {
  const text = await composeText();
  expect(text).toContain("opentofu-runner:");
  expect(text).toContain("dockerfile: runner/Dockerfile");
  // Internal network only: the runner must not publish host ports.
  const runnerSection = text.slice(
    text.indexOf("opentofu-runner:"),
    text.indexOf("accounts:"),
  );
  expect(runnerSection).not.toContain("ports:");
  expect(runnerSection).toContain('- "8080"');
  // The service reaches it over the compose network with the shared bearer.
  expect(text).toContain(
    "TAKOSUMI_OPENTOFU_RUNNER_URL: ${TAKOSUMI_OPENTOFU_RUNNER_URL:-http://opentofu-runner:8080}",
  );
  expect(text).toContain(
    "TAKOSUMI_RUNNER_SHARED_TOKEN: ${TAKOSUMI_RUNNER_SHARED_TOKEN:?",
  );
});

test("durable runtime volume backs sealed state artifacts", async () => {
  const text = await composeText();
  expect(text).toContain("- takosumi-runtime:/var/lib/takosumi");
  expect(text).toContain("TAKOSUMI_RUNTIME_DIR: /var/lib/takosumi");
  const volumes = text.slice(text.lastIndexOf("volumes:"));
  expect(volumes).toContain("takosumi-runtime:");
});

test(".env.example documents every required value with generation guidance", async () => {
  const text = await Bun.file(envExamplePath).text();
  for (const name of [
    "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT",
    "TAKOSUMI_SECRET_STORE_PASSPHRASE",
    "TAKOSUMI_DEPLOY_CONTROL_TOKEN",
    "TAKOSUMI_RUNNER_SHARED_TOKEN",
  ]) {
    expect(text).toContain(`${name}=`);
  }
  expect(text).toContain("openssl rand -hex 32");
  expect(text).toContain("TAKOSUMI_TCS_STORE_URL");
});

test("the documented build:dashboard script exists", async () => {
  const pkg = (await Bun.file(
    new URL("../../../package.json", import.meta.url),
  ).json()) as { readonly scripts?: Record<string, string> };
  expect(pkg.scripts?.["build:dashboard"]).toBeDefined();
});
