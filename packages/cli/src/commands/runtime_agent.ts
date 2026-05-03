import { Command } from "@cliffy/command";

const serveCmd = new Command()
  .description("Start the runtime-agent HTTP server")
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

const listCmd = new Command()
  .description("List connectors registered on a runtime-agent")
  .option(
    "--url <url:string>",
    "Agent URL (defaults to TAKOSUMI_AGENT_URL env)",
  )
  .option(
    "--token <token:string>",
    "Bearer token (defaults to TAKOSUMI_AGENT_TOKEN env)",
  )
  .action(async ({ url, token }) => {
    const agentUrl = url ?? Deno.env.get("TAKOSUMI_AGENT_URL");
    const agentToken = token ?? Deno.env.get("TAKOSUMI_AGENT_TOKEN");
    if (!agentUrl || !agentToken) {
      console.error(
        "Set --url + --token (or TAKOSUMI_AGENT_URL + TAKOSUMI_AGENT_TOKEN env)",
      );
      Deno.exit(1);
    }
    const res = await fetch(`${agentUrl}/v1/connectors`, {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    if (!res.ok) {
      console.error(`agent ${agentUrl}/v1/connectors returned ${res.status}`);
      console.error(await res.text());
      Deno.exit(1);
    }
    const body = await res.json() as {
      connectors: Array<{ shape: string; provider: string }>;
    };
    if (body.connectors.length === 0) {
      console.log(
        "no connectors registered (operator likely missing cloud env vars)",
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
  });

const verifyCmd = new Command()
  .description(
    "Smoke-test connector credentials & connectivity (read-only API call per connector)",
  )
  .option(
    "--url <url:string>",
    "Agent URL (defaults to TAKOSUMI_AGENT_URL env)",
  )
  .option(
    "--token <token:string>",
    "Bearer token (defaults to TAKOSUMI_AGENT_TOKEN env)",
  )
  .option(
    "--shape <shape:string>",
    "Restrict to connectors implementing this shape",
  )
  .option(
    "--provider <provider:string>",
    "Restrict to a single provider id",
  )
  .action(async ({ url, token, shape, provider }) => {
    const agentUrl = url ?? Deno.env.get("TAKOSUMI_AGENT_URL");
    const agentToken = token ?? Deno.env.get("TAKOSUMI_AGENT_TOKEN");
    if (!agentUrl || !agentToken) {
      console.error(
        "Set --url + --token (or TAKOSUMI_AGENT_URL + TAKOSUMI_AGENT_TOKEN env)",
      );
      Deno.exit(1);
    }
    const filter: Record<string, string> = {};
    if (shape) filter.shape = shape;
    if (provider) filter.provider = provider;
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
      Deno.exit(1);
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
        "no connectors registered (operator likely missing cloud env vars)",
      );
      return;
    }
    renderVerifyTable(body.results);
    const anyFailed = body.results.some((r) => !r.ok);
    if (anyFailed) Deno.exit(2);
  });

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

export const runtimeAgentCommand = new Command()
  .description("Operate the Takosumi runtime-agent")
  .command("serve", serveCmd)
  .command("list", listCmd)
  .command("verify", verifyCmd);

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
      (value.startsWith('"') && value.endsWith('"')) ||
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
