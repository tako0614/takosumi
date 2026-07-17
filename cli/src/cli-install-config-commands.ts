import { readFile } from "node:fs/promises";
import { INTERNAL_V1_PREFIX } from "takosumi-contract/api-surface";
import { INSTALL_CONFIG_PATCH_V1_KIND } from "takosumi-contract/install-configs";
import {
  booleanOption,
  optionalStringOption,
  parseOptions,
} from "./cli-options.ts";
import {
  installConfigsHelpText,
  installConfigsPatchHelpText,
} from "./cli-help.ts";
import { requestDeployControlApi } from "./cli-deploy-control-api.ts";
import type { CliIo } from "./cli-io.ts";
import { isRecord, parseJson, stringValue } from "./cli-util.ts";

export async function runInstallConfigs(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    io.stdout(installConfigsHelpText());
    return 0;
  }
  if (command === "patch") return await runInstallConfigPatch(rest, io);
  io.stderr(`Unknown install-configs command: ${command}`);
  io.stderr(installConfigsHelpText());
  return 2;
}

export async function runInstallConfigPatch(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [installConfigId, ...rest] = args;
  const options = parseOptions(rest);
  if (options.help) {
    io.stdout(installConfigsPatchHelpText());
    return 0;
  }
  if (!installConfigId || installConfigId.startsWith("--")) {
    io.stderr("install config id is required");
    return 2;
  }
  try {
    const file = optionalStringOption(options, "file");
    if (!file) throw new TypeError("--file is required");
    const body = parseJson(await readFile(file, "utf8"));
    if (!isRecord(body)) {
      throw new TypeError("--file must contain a JSON object");
    }
    if (body.kind !== INSTALL_CONFIG_PATCH_V1_KIND) {
      throw new TypeError(
        `--file kind must be ${INSTALL_CONFIG_PATCH_V1_KIND}`,
      );
    }
    const response = await requestDeployControlApi({
      path: `${INTERNAL_V1_PREFIX}/install-configs/${encodeURIComponent(installConfigId)}`,
      method: "PATCH",
      body,
      options,
    });
    io.stdout(
      formatInstallConfigPatch(response, booleanOption(options, "json")),
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return error instanceof TypeError ? 2 : 1;
  }
}

function formatInstallConfigPatch(value: unknown, json: boolean): string {
  if (json) return JSON.stringify(value, null, 2);
  if (!isRecord(value) || !isRecord(value.installConfig)) {
    throw new Error("Takosumi returned an invalid InstallConfig response");
  }
  const id = stringValue(value.installConfig.id);
  const updatedAt = stringValue(value.installConfig.updatedAt);
  if (!id || !updatedAt) {
    throw new Error("Takosumi returned an invalid InstallConfig response");
  }
  return `InstallConfig ${id} patched at ${updatedAt}`;
}
