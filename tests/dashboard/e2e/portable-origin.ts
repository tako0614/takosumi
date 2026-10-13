/** Keep the fixture listener, browser and traffic assertions on the same port. */
export function resolvePortablePort(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = environment.TAKOSUMI_E2E_PORT?.trim() || "4179";
  const port = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("TAKOSUMI_E2E_PORT must be a valid TCP port");
  }
  return port;
}

export function resolvePortableOrigin(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return new URL(`http://127.0.0.1:${resolvePortablePort(environment)}`).origin;
}
