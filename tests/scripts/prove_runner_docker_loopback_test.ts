import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROOF_SCRIPT = join(import.meta.dir, "../../scripts/prove-runner-docker.sh");

function nulArgs(path: string): string[] {
  return readFileSync(path, "utf8").split("\0").filter(Boolean);
}

test("publishes the ephemeral runner port on loopback and cleans up its own failed probe", () => {
  for (const apparmor of ["0", "1"]) {
    const root = mkdtempSync(join(tmpdir(), "tk-loopback-"));
    chmodSync(root, 0o700);
    const bin = join(root, "bin");
    mkdirSync(bin, { mode: 0o700 });
    const dockerRun = join(root, "docker-run.args");
    const dockerPort = join(root, "docker-port.args");
    const dockerCleanup = join(root, "docker-cleanup.args");
    const curlCalled = join(root, "curl-called");
    const docker = join(bin, "docker");
    const curl = join(bin, "curl");

    try {
      writeFileSync(
        docker,
        `#!/usr/bin/env bash
set -eu
command="$1"
shift
case "$command" in
  image)
    if [[ " $* " == *" --format "* ]]; then printf '0\\n'; fi
    ;;
  run)
    printf '%s\\0' "$@" > "$DOCKER_RUN_CAPTURE"
    ;;
  port)
    printf '%s\\0' "$@" > "$DOCKER_PORT_CAPTURE"
    exit 23
    ;;
  rm)
    printf '%s\\0' "$@" >> "$DOCKER_CLEANUP_CAPTURE"
    ;;
  *)
    exit 91
    ;;
esac
`,
        { mode: 0o700 },
      );
      writeFileSync(
        curl,
        `#!/usr/bin/env bash
printf 'called' > "$CURL_CALLED_CAPTURE"
exit 92
`,
        { mode: 0o700 },
      );
      chmodSync(docker, 0o700);
      chmodSync(curl, 0o700);

      const result = spawnSync("bash", [PROOF_SCRIPT], {
        encoding: "utf8",
        timeout: 8_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          TAKOSUMI_RUNNER_PROOF_SKIP_BUILD: "1",
          TAKOSUMI_RUNNER_PROOF_APPARMOR_UNCONFINED: apparmor,
          DOCKER_RUN_CAPTURE: dockerRun,
          DOCKER_PORT_CAPTURE: dockerPort,
          DOCKER_CLEANUP_CAPTURE: dockerCleanup,
          CURL_CALLED_CAPTURE: curlCalled,
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(23);
      expect(result.stdout).toContain("STEP 2: run container detached");
      expect(result.stdout).not.toContain("STEP 3: wait for /healthz readiness");

      const runArgs = nulArgs(dockerRun);
      const publishIndex = runArgs.indexOf("-p");
      expect(publishIndex).toBeGreaterThanOrEqual(0);
      expect(runArgs[publishIndex + 1]).toBe("127.0.0.1:0:8080");
      expect(runArgs).not.toContain("0:8080");
      if (apparmor === "1") {
        expect(runArgs).toContain("--security-opt");
        expect(runArgs).toContain("apparmor=unconfined");
      } else {
        expect(runArgs).not.toContain("--security-opt");
      }

      const containerIndex = runArgs.indexOf("--name");
      const containerName = runArgs[containerIndex + 1];
      expect(containerName).toMatch(/^takosumi-runner-proof-\d+$/u);
      expect(nulArgs(dockerPort)).toEqual([containerName, "8080/tcp"]);
      expect(nulArgs(dockerCleanup)).toEqual(["-f", containerName]);
      expect(existsSync(curlCalled)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
