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
    if (!agentUrl && !agentDisabled) {
      const { startEmbeddedAgent } = await import(
        "@takos/takosumi-runtime-agent/embed"
      );
      const handle = startEmbeddedAgent({ port: agentPort });
      console.log(
        `[takosumi-server] embedded runtime-agent listening at ${handle.url}`,
      );
      console.log(
        `[takosumi-server] (operators running an external agent should set ${LIFECYCLE_AGENT_URL_ENV})`,
      );
    }
    Deno.env.set("PORT", String(port));
    await import("@takos/takosumi-kernel");
  });
