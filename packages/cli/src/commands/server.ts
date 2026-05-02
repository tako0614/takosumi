import { Command } from "@cliffy/command";
import {
  LIFECYCLE_AGENT_TOKEN_ENV,
  LIFECYCLE_AGENT_URL_ENV,
} from "takosumi-contract";

export const serverCommand = new Command()
  .description("Start the Takosumi kernel HTTP server")
  .option("--port <port:number>", "Port to listen on", { default: 8788 })
  .option(
    "--agent-port <port:number>",
    "Port for the embedded runtime-agent (only used when TAKOSUMI_AGENT_URL is unset)",
    { default: 8789 },
  )
  .option(
    "--no-agent",
    "Skip starting the embedded runtime-agent (operator must run one separately)",
  )
  .action(async ({ port, agentPort, agent }) => {
    const agentDisabled = agent === false;
    const agentUrl = Deno.env.get(LIFECYCLE_AGENT_URL_ENV);
    let agentShutdown: (() => Promise<void>) | undefined;
    if (!agentUrl && !agentDisabled) {
      const { startEmbeddedAgent } = await import(
        "@takos/takosumi-runtime-agent/embed"
      );
      const handle = startEmbeddedAgent({ port: agentPort });
      agentShutdown = handle.shutdown;
      console.log(
        `[takosumi-server] embedded runtime-agent listening at ${handle.url}`,
      );
      console.log(
        `[takosumi-server] (operators running an external agent should set ${LIFECYCLE_AGENT_URL_ENV})`,
      );
    }
    if (agentShutdown) {
      registerShutdownHandlers(agentShutdown);
    }
    Deno.env.set("PORT", String(port));
    await import("@takos/takosumi-kernel");
  });

function registerShutdownHandlers(shutdown: () => Promise<void>): void {
  let shuttingDown = false;
  const handler = (signal: Deno.Signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[takosumi-server] received ${signal}, draining...`);
    shutdown()
      .catch((err) => console.error("[takosumi-server] shutdown error:", err))
      .finally(() => Deno.exit(0));
  };
  Deno.addSignalListener("SIGINT", () => handler("SIGINT"));
  Deno.addSignalListener("SIGTERM", () => handler("SIGTERM"));
}
