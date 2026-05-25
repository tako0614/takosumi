/**
 * Mock installer service for local-substrate.
 *
 * Returns the v1 InstallationDryRunResponse shape (source + manifestDigest +
 * changes[] + expected.{commit, manifestDigest}) per the AppSpec /
 * Installation / Deployment contract.
 *
 * Primary path: load pre-baked fixtures from /srv/fixtures/<repo>.json
 * (one per bundled app, mirroring the real `.takosumi.yml`).
 *
 * Fallback path: if no fixture matches the repo, derive deterministic fake
 * values from sha256(gitUrl+ref) so smoke tests against arbitrary URLs
 * don't break — log a warning so the operator knows the wizard is running
 * blind.
 *
 * Wire env (worker → mock):
 *   TAKOSUMI_ACCOUNTS_INSTALLER_URL=http://installer-mock:8788
 */

const PORT = Number(Deno.env.get("PORT") ?? "8788");

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function appIdFromGitUrl(gitUrl: string): string {
  try {
    const u = new URL(gitUrl);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "fake-app";
    return last.replace(/\.git$/, "");
  } catch {
    return "fake-app";
  }
}

const FIXTURE_DIR = "/srv/fixtures";

async function loadFixture(
  repoBasename: string,
): Promise<Record<string, unknown> | null> {
  try {
    const text = await Deno.readTextFile(`${FIXTURE_DIR}/${repoBasename}.json`);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/healthz") {
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }
  if (url.pathname !== "/v1/installations/dry-run") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (req.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const source = (body.source ?? {}) as Record<string, unknown>;
  const gitUrl = String(source.url ?? source.gitUrl ?? body.gitUrl ?? "");
  const ref = String(source.ref ?? body.ref ?? "main");
  if (!gitUrl) {
    return Response.json({
      error: "invalid_request",
      error_description: "source.url required",
    }, { status: 400 });
  }

  const repoBasename = appIdFromGitUrl(gitUrl);

  // Fixture path: real .takosumi.yml-derived response if we have one.
  const fixture = await loadFixture(repoBasename);
  if (fixture) {
    const src = (fixture.source ?? {}) as Record<string, unknown>;
    if (ref !== src.ref) {
      const fp = await sha256Hex(`${gitUrl}@${ref}`);
      const commit = fp.slice(0, 40);
      fixture.source = {
        ...src,
        ref,
        commit,
      };
      fixture.expected = { commit, manifestDigest: `sha256:${fp}` };
      fixture.manifestDigest = `sha256:${fp}`;
    }
    const changes = ((fixture.changes ?? []) as unknown[]).length;
    console.log(
      `[installer-mock] fixture-hit ${repoBasename} → appId=${fixture.appId} ` +
        `changes=${changes}`,
    );
    return Response.json(fixture);
  }

  // Fallback: deterministic fake for arbitrary git URLs. Loud-warn so operator
  // knows the wizard is running blind.
  const fingerprint = await sha256Hex(`${gitUrl}@${ref}`);
  const commit = fingerprint.slice(0, 40);
  const digest = `sha256:${fingerprint}`;
  console.warn(
    `[installer-mock] FALLBACK no fixture for ${repoBasename}; ` +
      `returning empty changes[]. Run scripts/refresh-installer-fixtures.sh ` +
      `to add this repo to the fixture set.`,
  );

  return Response.json({
    appId: repoBasename,
    source: { kind: "git", url: gitUrl, ref, commit },
    manifestDigest: digest,
    changes: [],
    expected: { commit, manifestDigest: digest },
    metadata: {
      mock: true,
      fixture: false,
      service: "installer-mock (local-substrate)",
      generatedAt: new Date().toISOString(),
    },
  });
});

console.log(`[installer-mock] listening on :${PORT}`);
