import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  TAKOSUMI_BACKGROUND_EVENT_ABI,
  TAKOSUMI_MANAGED_RUNTIME_CONNECTION_CONTRACT,
} from "../../contract/index.ts";
import { TAKOSUMI_BACKGROUND_EVENT_INVOKE_PATH } from "../../contract/background-events.ts";
import {
  TAKOSUMI_MANAGED_RUNTIME_GATEWAY_BINDING,
  TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION_BINDING,
} from "../../contract/managed-runtime-connections.ts";

const packageJson = JSON.parse(
  await readFile(
    new URL("../../contract/package.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly files?: readonly string[];
  readonly exports?: Readonly<Record<string, string>>;
  readonly publishConfig?: { readonly access?: string };
};

test("the OSS contract directory is an explicit public package", () => {
  expect(packageJson).toMatchObject({
    name: "@takosjp/takosumi-contract",
    version: "2.0.0",
    publishConfig: { access: "public" },
  });
  expect(packageJson.private).not.toBe(true);
  expect(packageJson.files).toEqual([
    "runtime.ts",
    "background-events.ts",
    "managed-runtime-connections.ts",
    "managed-relational-runtime.ts",
    "README.md",
  ]);
  expect(packageJson.exports).toEqual({
    ".": "./runtime.ts",
    "./background-events": "./background-events.ts",
    "./managed-runtime-connections": "./managed-runtime-connections.ts",
    "./managed-relational-runtime": "./managed-relational-runtime.ts",
  });
});

test("root and explicit runtime subpaths expose one contract identity", () => {
  expect(TAKOSUMI_BACKGROUND_EVENT_ABI).toBe("takosumi.background-event/v2");
  expect(TAKOSUMI_BACKGROUND_EVENT_INVOKE_PATH).toBe(
    "/.well-known/takosumi/background-events/v2/invoke",
  );
  expect(TAKOSUMI_MANAGED_RUNTIME_CONNECTION_CONTRACT).toBe(
    "takosumi.managed-runtime-connection/v1",
  );
  expect(TAKOSUMI_MANAGED_RUNTIME_GATEWAY_BINDING).toBe(
    "TAKOSUMI_MANAGED_RUNTIME",
  );
  expect(TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION_BINDING).toBe(
    "TAKOSUMI_MANAGED_RUNTIME_MATERIALIZATION",
  );
});
