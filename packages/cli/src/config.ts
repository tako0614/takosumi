export interface CliConfig {
  readonly kernelUrl?: string;
  readonly token?: string;
}

export function loadConfig(): CliConfig {
  return {
    kernelUrl: Deno.env.get("TAKOSUMI_KERNEL_URL"),
    token: Deno.env.get("TAKOSUMI_TOKEN"),
  };
}

export function resolveMode(
  flags: { remote?: string; token?: string },
  config: CliConfig,
): { mode: "local" } | { mode: "remote"; url: string; token?: string } {
  const url = flags.remote ?? config.kernelUrl;
  if (!url) return { mode: "local" };
  return { mode: "remote", url, token: flags.token ?? config.token };
}
