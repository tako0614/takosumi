#!/usr/bin/env bun
import type { InstalledFormReference, JsonObject } from "takosumi-contract";
import { isInstalledFormReference } from "takosumi-contract";
import { runPortableFormHostConformance } from "../core/conformance/portable_form_host.ts";

const args = parseArgs(process.argv.slice(2));
const endpoint = required(args, "endpoint");
const space = required(args, "space");
const name = required(args, "name");
const identity = await readJson(required(args, "identity"));
if (!isInstalledFormReference(identity)) {
  throw new TypeError(
    "--identity must contain one exact InstalledFormReference",
  );
}
const desired = await readJson(required(args, "desired"));
if (!isObject(desired))
  throw new TypeError("--desired must contain a JSON object");
const token = args["token-env"] ? process.env[args["token-env"]] : undefined;
if (args["token-env"] && !token) {
  throw new TypeError(
    `token environment variable ${args["token-env"]} is empty`,
  );
}
const importNativeId = args["import-native-id-env"]
  ? process.env[args["import-native-id-env"]]
  : undefined;

const report = await runPortableFormHostConformance({
  endpoint,
  space,
  name,
  identity,
  desired: desired as JsonObject,
  ...(token ? { token } : {}),
  ...(importNativeId ? { importNativeId } : {}),
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function parseArgs(values: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new TypeError(
        "usage: --endpoint URL --space ID --name NAME --identity FILE --desired FILE [--token-env ENV] [--import-native-id-env ENV]",
      );
    }
    result[key.slice(2)] = value;
  }
  return result;
}

function required(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (!value) throw new TypeError(`--${key} is required`);
  return value;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await Bun.file(path).text()) as unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
