import { Command } from "@cliffy/command";
import {
  fetchKernelPluginMarketplaceIndex,
  installKernelPluginMarketplacePackages,
} from "@takos/takosumi-kernel/plugins";

function createMarketplaceFetchCommand() {
  return new Command()
    .description("Fetch and inspect a Takosumi plugin marketplace index")
    .option("--url <url:string>", "Marketplace index URL", { required: true })
    .option("--json", "Print the normalized marketplace JSON")
    .action(async ({ url, json }) => {
      const index = await fetchKernelPluginMarketplaceIndex({ url });
      if (json) {
        console.log(JSON.stringify(index, null, 2));
        return;
      }
      console.log(`${index.marketplaceId} ${index.generatedAt}`);
      for (const packageRecord of index.packages) {
        console.log(
          `${packageRecord.packageRef} ${packageRecord.version} ` +
            `${packageRecord.kind} ${packageRecord.module.digest}`,
        );
      }
    });
}

function createInstallCommand() {
  return new Command()
    .description(
      "Verify and install a digest-pinned marketplace plugin package",
    )
    .option("--marketplace <url:string>", "Marketplace index URL", {
      required: true,
    })
    .option("--package <ref:string>", "Package ref to install", {
      required: true,
    })
    .option("--trust-keys <path:file>", "Trusted publisher keys JSON file", {
      required: true,
    })
    .option("--policy <path:file>", "Install policy JSON file", {
      required: true,
    })
    .option(
      "--environment <name:string>",
      "Runtime environment for install policy checks",
      { default: "production" },
    )
    .action(async (flags) => {
      const index = await fetchKernelPluginMarketplaceIndex({
        url: flags.marketplace,
      });
      const trustedKeys = await readJsonFile(flags.trustKeys, "trust keys");
      const policy = await readJsonFile(flags.policy, "install policy");
      const result = await installKernelPluginMarketplacePackages({
        indexes: [index],
        packageRefs: [flags.package],
        trustedKeys,
        policy,
        environment: flags.environment,
      });
      for (const packageRecord of result.packages) {
        console.log(
          `installed ${packageRecord.packageRef} ${packageRecord.version} ` +
            `${packageRecord.kind} ${packageRecord.moduleDigest}`,
        );
      }
    });
}

function createMarketplaceCommand() {
  return new Command()
    .description("Inspect plugin marketplace indexes")
    .command("fetch", createMarketplaceFetchCommand());
}

function createPluginCommand() {
  return new Command()
    .description("Install and inspect Takosumi plugin packages")
    .command("marketplace", createMarketplaceCommand())
    .command("install", createInstallCommand());
}

export const pluginCommand: ReturnType<typeof createPluginCommand> =
  createPluginCommand();

async function readJsonFile<T = never>(
  path: string,
  label: string,
): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read ${label} from ${path}: ${message}`);
  }
}
