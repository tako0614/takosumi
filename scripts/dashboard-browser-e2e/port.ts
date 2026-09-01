/**
 * Port selection for the portable dashboard browser E2E.
 *
 * The fixture server used to bind a fixed 4179, so two checkouts of this
 * repository could not run `bun run check` at the same time: the second run
 * died with a bare "port is already used" from Playwright's web-server probe.
 * The launcher now picks a free port per run and publishes it through
 * `TAKOSUMI_E2E_PORT`, which the Playwright config, the spec, and the fixture
 * server all read. An explicit `TAKOSUMI_E2E_PORT` still wins.
 */

export const DEFAULT_PORTABLE_E2E_PORT = 4179;

export class PortableE2EPortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortableE2EPortError";
  }
}

/** Parse an explicitly requested port, or `undefined` when none was set. */
export function explicitPortableE2EPort(
  env: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const raw = env.TAKOSUMI_E2E_PORT?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new PortableE2EPortError(
      `TAKOSUMI_E2E_PORT must be a valid TCP port, got ${raw}`,
    );
  }
  return port;
}

/**
 * Resolve the port a reader (config / spec / fixture server) should use.
 * Readers never choose: they take what the launcher published, and fall back
 * to the historical default so a hand-run `bunx playwright test` still works.
 */
export function portableE2EPort(
  env: Readonly<Record<string, string | undefined>>,
): number {
  return explicitPortableE2EPort(env) ?? DEFAULT_PORTABLE_E2E_PORT;
}

/**
 * Ask the OS for a free port by binding to 0 and releasing it. A concurrent
 * run could still claim the same port in the gap, but the window is a few
 * milliseconds instead of "every run wants 4179".
 */
export async function pickFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const { port } = server;
  await server.stop(true);
  return port;
}

/**
 * Publish the port for the child processes of a portable run.
 * @returns the port every reader will see.
 */
export async function resolvePortableE2EPort(
  env: Record<string, string | undefined>,
): Promise<number> {
  const explicit = explicitPortableE2EPort(env);
  if (explicit !== undefined) return explicit;
  const port = await pickFreePort();
  env.TAKOSUMI_E2E_PORT = String(port);
  return port;
}
