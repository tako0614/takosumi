/**
 * Playwright global setup. Ensures Chromium trusts the local-substrate
 * Pebble root by writing it into the per-user NSS DB that Chromium reads.
 *
 * This replaces the previous `ignoreHTTPSErrors: true` config (which
 * defeated the very TLS trust we set up in scripts/ca-install.sh): now
 * Playwright actually validates the cert chain, and the test will fail
 * if Pebble's root is missing or wrong.
 *
 * Local dev: if you've already run `sudo bash scripts/ca-install.sh`,
 * NSS DB is populated. This setup is idempotent.
 *
 * CI: the workflow runs `apt-get install libnss3-tools` and this setup
 * picks up the Pebble root from local-substrate/caddy/runtime/.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SETUP_DIR = dirname(fileURLToPath(import.meta.url));
const CERTUTIL_TIMEOUT_MS = 10_000;

export default function globalSetup(): void {
  // CI passes PEBBLE_CA_PATH explicitly (the docker container mount layout
  // doesn't include the whole ecosystem). Local dev falls back to the
  // filesystem traversal that works from the dashboard-ui workspace.
  const explicit = process.env.PEBBLE_CA_PATH;
  let caPath: string;
  if (explicit) {
    caPath = resolve(explicit);
  } else {
    const repoRoot = resolve(SETUP_DIR, "../../../../..");
    caPath = resolve(
      repoRoot,
      "takosumi/deploy/local-substrate/caddy/runtime/pebble-issuance-root.pem",
    );
  }
  if (!existsSync(caPath)) {
    throw new Error(
      `Pebble root not found at ${caPath}. ` +
        `Set PEBBLE_CA_PATH env or run scripts/up.sh in takosumi/deploy/local-substrate first.`,
    );
  }
  const nssDir = `${homedir()}/.pki/nssdb`;
  const nssCertDb = `${nssDir}/cert9.db`;
  try {
    execSync("command -v certutil", { stdio: "ignore" });
  } catch {
    throw new Error(
      "certutil not found. Install libnss3-tools " +
        "(apt: `sudo apt-get install libnss3-tools`).",
    );
  }
  try {
    execSync(`mkdir -p "${nssDir}"`, { stdio: "ignore" });
    if (!existsSync(nssCertDb)) {
      execSync(`certutil -d "sql:${nssDir}" -N --empty-password`, {
        stdio: "ignore",
        timeout: CERTUTIL_TIMEOUT_MS,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to initialize Chromium NSS DB: ${message}`);
  }
  // Delete + re-add so we pick up Pebble root rotations on up.sh restart.
  try {
    execSync(
      `certutil -d "sql:${nssDir}" -D -n takos-local-substrate-pebble`,
      { stdio: "ignore", timeout: CERTUTIL_TIMEOUT_MS },
    );
  } catch {
    /* not present, fine */
  }
  execSync(
    `certutil -d "sql:${nssDir}" -A -n takos-local-substrate-pebble ` +
      `-t TC,, -i "${caPath}"`,
    { stdio: "inherit", timeout: CERTUTIL_TIMEOUT_MS },
  );
  console.log("[playwright/_setup] Pebble root installed into NSS DB");
}
