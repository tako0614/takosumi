import { Command } from "../command.ts";
import {
  exitCli,
  onCliSignal,
  readEnv,
  readTextFile,
  setEnv,
} from "../runtime.ts";

function createServeCmd(): Command {
  return new Command("serve")
    .description("Start the runtime-agent HTTP server")
    .option("--port <port>", "Port to listen on", (v) => Number(v), 8789)
    .option("--hostname <hostname>", "Hostname to bind", "127.0.0.1")
    .option(
      "--token <token>",
      "Bearer token (defaults to TAKOSUMI_AGENT_TOKEN env or random)",
    )
    .option(
      "--env-file <path>",
      "Load extra env vars before starting the generic agent",
    )
    .action(
      async (
        opts: {
          port: number;
          hostname: string;
          token?: string;
          envFile?: string;
        },
      ) => {
        if (opts.envFile) {
          await loadEnvFile(opts.envFile);
        }
        const { startEmbeddedAgent } = await import(
          "../../runtime-agent/embed.ts"
        );
        const explicitToken = opts.token ?? readEnv("TAKOSUMI_AGENT_TOKEN");
        const handle = startEmbeddedAgent({
          port: opts.port,
          hostname: opts.hostname,
          token: explicitToken,
          exportToProcessEnv: false,
        });
        console.log(`takosumi runtime-agent listening at ${handle.url}`);
        console.log(`  TAKOSUMI_AGENT_URL=${handle.url}`);
        console.log(`  TAKOSUMI_AGENT_TOKEN=${handle.token}`);
        console.log("Set the above env on the kernel host to wire it through.");
        await waitForShutdown();
        await handle.shutdown();
      },
    ) as Command;
}

function createListCmd(): Command {
  return new Command("list")
    .description("List connectors registered on a runtime-agent")
    .option("--url <url>", "Agent URL (defaults to TAKOSUMI_AGENT_URL env)")
    .option(
      "--token <token>",
      "Bearer token (defaults to TAKOSUMI_AGENT_TOKEN env)",
    )
    .action(async (opts: { url?: string; token?: string }) => {
      const agentUrl = opts.url ?? readEnv("TAKOSUMI_AGENT_URL");
      const agentToken = opts.token ?? readEnv("TAKOSUMI_AGENT_TOKEN");
      if (!agentUrl || !agentToken) {
        console.error(
          "Set --url + --token (or TAKOSUMI_AGENT_URL + TAKOSUMI_AGENT_TOKEN env)",
        );
        exitCli(1);
      }
      const res = await fetch(`${agentUrl}/v1/connectors`, {
        headers: { authorization: `Bearer ${agentToken}` },
      });
      if (!res.ok) {
        console.error(`agent ${agentUrl}/v1/connectors returned ${res.status}`);
        console.error(await res.text());
        exitCli(1);
      }
      const body = await res.json() as {
        connectors: Array<{ shape: string; provider: string }>;
      };
      if (body.connectors.length === 0) {
        console.log(
          "no connectors registered (operator must pass a registry in their distribution)",
        );
        return;
      }
      const grouped = new Map<string, string[]>();
      for (const c of body.connectors) {
        const list = grouped.get(c.shape) ?? [];
        list.push(c.provider);
        grouped.set(c.shape, list);
      }
      for (const [shape, providers] of grouped) {
        console.log(`${shape}:`);
        for (const provider of providers.sort()) {
          console.log(`  - ${provider}`);
        }
      }
    }) as Command;
}

function createVerifyCmd(): Command {
  return new Command("verify")
    .description(
      "Smoke-test connector credentials & connectivity (read-only API call per connector)",
    )
    .option("--url <url>", "Agent URL (defaults to TAKOSUMI_AGENT_URL env)")
    .option(
      "--token <token>",
      "Bearer token (defaults to TAKOSUMI_AGENT_TOKEN env)",
    )
    .option("--shape <shape>", "Restrict to connectors implementing this shape")
    .option("--provider <provider>", "Restrict to a single provider id")
    .action(
      async (
        opts: {
          url?: string;
          token?: string;
          shape?: string;
          provider?: string;
        },
      ) => {
        const agentUrl = opts.url ?? readEnv("TAKOSUMI_AGENT_URL");
        const agentToken = opts.token ?? readEnv("TAKOSUMI_AGENT_TOKEN");
        if (!agentUrl || !agentToken) {
          console.error(
            "Set --url + --token (or TAKOSUMI_AGENT_URL + TAKOSUMI_AGENT_TOKEN env)",
          );
          exitCli(1);
        }
        const filter: Record<string, string> = {};
        if (opts.shape) filter.shape = opts.shape;
        if (opts.provider) filter.provider = opts.provider;
        const res = await fetch(`${agentUrl}/v1/lifecycle/verify`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${agentToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(filter),
        });
        if (!res.ok) {
          console.error(
            `agent ${agentUrl}/v1/lifecycle/verify returned ${res.status}`,
          );
          console.error(await res.text());
          exitCli(1);
        }
        const body = await res.json() as {
          results: Array<{
            shape: string;
            provider: string;
            ok: boolean;
            note?: string;
            code?: string;
          }>;
        };
        if (body.results.length === 0) {
          console.log(
            "no connectors registered (operator must pass a registry in their distribution)",
          );
          return;
        }
        renderVerifyTable(body.results);
        const anyFailed = body.results.some((r) => !r.ok);
        if (anyFailed) exitCli(2);
      },
    ) as Command;
}

function renderVerifyTable(
  results: ReadonlyArray<{
    shape: string;
    provider: string;
    ok: boolean;
    note?: string;
    code?: string;
  }>,
): void {
  const rows = results.map((r) => ({
    name: `${r.shape}/${r.provider}`,
    mark: r.ok ? "ok" : "FAIL",
    detail: r.code ? `[${r.code}] ${r.note ?? ""}` : (r.note ?? ""),
  }));
  const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));
  const markWidth = Math.max(4, ...rows.map((r) => r.mark.length));
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(nameWidth)}  ${
        row.mark.padEnd(markWidth)
      }  ${row.detail}`,
    );
  }
}

// Build every subcommand fresh per call (see artifact.ts for the rationale):
// the CLI tests re-import this module and expect an independent command tree, so
// module-level subcommand singletons would be shared across parents and corrupt
// commander's parse state.
function createRuntimeAgentCommand(): Command {
  const command = new Command("runtime-agent")
    .description("Operate the Takosumi runtime-agent");
  command.addCommand(createServeCmd());
  command.addCommand(createListCmd());
  command.addCommand(createVerifyCmd());
  return command;
}

export const runtimeAgentCommand: Command = createRuntimeAgentCommand();

async function loadEnvFile(path: string): Promise<void> {
  const text = await readTextFile(path);
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    setEnv(key, value);
  }
}

function waitForShutdown(): Promise<void> {
  return new Promise<void>((resolve) => {
    const handle = (signal: "SIGINT" | "SIGTERM") => {
      console.log(`received ${signal}, shutting down`);
      resolve();
    };
    onCliSignal("SIGINT", () => handle("SIGINT"));
    onCliSignal("SIGTERM", () => handle("SIGTERM"));
  });
}
