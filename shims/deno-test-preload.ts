// Bun migration: register a `Deno.test`-compatible global backed by bun:test.
//
// Preloaded before legacy Deno-style script tests evaluate. New tests should use
// bun:test directly; this keeps old guard tests runnable under `bun test`.
import { test as bunTest } from "bun:test";

type TestFn = (t: TestContext) => unknown | Promise<unknown>;

interface TestContext {
  name: string;
  step(
    name: string,
    fn: (t: TestContext) => unknown | Promise<unknown>,
  ): Promise<boolean>;
  step(
    def: { name: string; fn: (t: TestContext) => unknown | Promise<unknown> },
  ): Promise<boolean>;
}

interface TestDef {
  name?: string;
  fn?: TestFn;
  ignore?: boolean;
  only?: boolean;
}

function makeContext(name: string): TestContext {
  return {
    name,
    async step(a: unknown, b?: unknown): Promise<boolean> {
      const stepName = typeof a === "string" ? a : (a as { name: string }).name;
      const stepFn =
        (typeof a === "string" ? b : (a as { fn: TestFn }).fn) as TestFn;
      try {
        await stepFn(makeContext(`${name} > ${stepName}`));
        return true;
      } catch (err) {
        if (err instanceof Error) {
          err.message = `[step: ${stepName}] ${err.message}`;
        }
        throw err;
      }
    },
  };
}

function register(a: unknown, b?: unknown, c?: unknown): void {
  let name: string;
  let fn: TestFn;
  let ignore = false;
  let only = false;

  if (typeof a === "object" && a !== null) {
    const def = a as TestDef;
    name = def.name ?? def.fn?.name ?? "(anonymous)";
    fn = def.fn ?? (() => {});
    ignore = !!def.ignore;
    only = !!def.only;
  } else if (typeof a === "function") {
    fn = a as TestFn;
    name = (a as { name?: string }).name || "(anonymous)";
  } else {
    name = String(a);
    if (typeof b === "function") {
      fn = b as TestFn;
    } else if (typeof b === "object" && b !== null) {
      const opts = b as TestDef;
      ignore = !!opts.ignore;
      only = !!opts.only;
      fn = c as TestFn;
    } else {
      fn = c as TestFn;
    }
  }

  const wrapped = async (): Promise<void> => {
    await fn(makeContext(name));
  };
  if (ignore) bunTest.skip(name, wrapped);
  else if (only) bunTest.only(name, wrapped);
  else bunTest(name, wrapped);
}

const g = globalThis as unknown as { Deno?: Record<string, unknown> };
g.Deno = Object.assign({}, g.Deno ?? {}, { test: register });

export {};
