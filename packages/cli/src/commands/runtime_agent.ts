import { Command } from "@cliffy/command";

export const runtimeAgentCommand = new Command()
  .description("Run a standalone Takosumi runtime-agent")
  .command("serve", "Start the runtime-agent HTTP server")
  .option("--port <port:number>", "Port to listen on", { default: 8789 })
  .option(
    "--hostname <hostname:string>",
    "Hostname to bind",
    { default: "127.0.0.1" },
  )
  .option(
    "--token <token:string>",
    "Bearer token (defaults to TAKOSUMI_AGENT_TOKEN env or random)",
  )
  .option(
    "--env-file <path:file>",
    "Load extra env vars from a dotenv-style file before building connectors",
  )
  .action(async ({ port, hostname, token, envFile }) => {
    if (envFile) {
      await loadEnvFile(envFile);
    }
    const { startEmbeddedAgent } = await import(
      "@takos/takosumi-runtime-agent/embed"
    );
    const explicitToken = token ?? Deno.env.get("TAKOSUMI_AGENT_TOKEN");
    const handle = startEmbeddedAgent({
      port,
      hostname,
      token: explicitToken,
      exportToProcessEnv: false,
    });
    console.log(`takosumi runtime-agent listening at ${handle.url}`);
    console.log(`  TAKOSUMI_AGENT_URL=${handle.url}`);
    console.log(`  TAKOSUMI_AGENT_TOKEN=${handle.token}`);
    console.log("Set the above env on the kernel host to wire it through.");
    await waitForShutdown();
    await handle.shutdown();
  });

async function loadEnvFile(path: string): Promise<void> {
  const text = await Deno.readTextFile(path);
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    Deno.env.set(key, value);
  }
}

function waitForShutdown(): Promise<void> {
  return new Promise<void>((resolve) => {
    const handle = (signal: Deno.Signal) => {
      console.log(`received ${signal}, shutting down`);
      resolve();
    };
    Deno.addSignalListener("SIGINT", () => handle("SIGINT"));
    Deno.addSignalListener("SIGTERM", () => handle("SIGTERM"));
  });
}
