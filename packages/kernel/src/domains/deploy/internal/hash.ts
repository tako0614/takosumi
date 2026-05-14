// Pure hash / freeze utilities shared across the deploy domain pipeline.
//
// These helpers were inlined inside `deployment_service.ts`; extracting them
// here keeps that file focused on the `DeploymentService` orchestration
// surface while letting future phase modules reuse the same deterministic
// digest function without circular imports.

import type { JsonObject } from "takosumi-contract";

export function stableHash(value: JsonObject | unknown): string {
  const input = stableStringify(value);
  const seeds = [
    0xcbf29ce484222325n,
    0x84222325cbf29ce4n,
    0x9e3779b97f4a7c15n,
    0x94d049bb133111ebn,
  ];
  return `sha256:${seeds.map((seed) => fnv1a64(input, seed)).join("")}`;
}

function fnv1a64(input: string, seed: bigint): string {
  let hash = seed;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${
      Object.keys(object).sort().map((key) =>
        `${JSON.stringify(key)}:${stableStringify(object[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
