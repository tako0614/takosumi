#!/usr/bin/env bun

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { classifyPlatformRequestDataAccess } from "../deploy/platform/request-data-access.ts";

const root = join(import.meta.dir, "../dashboard/dist");
const files = walk(root);
if (files.length === 0) {
  throw new Error("dashboard data-free check found no built assets");
}

const assets = { fetch: async () => new Response() };
const failures = files
  .map((file) => `/${relative(root, file).replaceAll("\\", "/")}`)
  .filter(
    (pathname) =>
      classifyPlatformRequestDataAccess(
        new Request(`https://app.example.test${pathname}`),
        { ASSETS: assets },
      ).kind !== "data-free",
  );

if (failures.length > 0) {
  throw new Error(
    `built dashboard files still require stateful admission:\n${failures.join("\n")}`,
  );
}

console.log(`dashboard data-free check passed (${files.length} files)`);

function walk(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
