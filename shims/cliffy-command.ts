// Bun migration REVIEW stub: @cliffy/command.
//
// @cliffy/command is a JSR-only package with no npm equivalent. The recipe's
// guidance is to port the CLI command tree to `commander` (REVIEW). That port is
// NOT done here: this stub exists only so that importing the CLI module under bun
// does not crash module evaluation of UNRELATED (non-CLI) test files that may sit
// in the same graph. The CLI itself is non-functional under bun until the
// commander port lands. See package.json / migration notes.
//
// Wired via tsconfig.json "paths": "@cliffy/command" -> this file.

type ActionFn = (...args: unknown[]) => unknown;

export class Command {
  #name = "";
  #version = "";
  #description = "";
  // deno-lint-ignore no-explicit-any
  constructor(..._args: any[]) {}
  name(n: string): this {
    this.#name = n;
    return this;
  }
  version(v: string): this {
    this.#version = v;
    return this;
  }
  description(d: string): this {
    this.#description = d;
    return this;
  }
  // deno-lint-ignore no-explicit-any
  arguments(..._a: any[]): this {
    return this;
  }
  // deno-lint-ignore no-explicit-any
  option(..._a: any[]): this {
    return this;
  }
  // deno-lint-ignore no-explicit-any
  command(..._a: any[]): this {
    return this;
  }
  action(_fn: ActionFn): this {
    return this;
  }
  // deno-lint-ignore no-explicit-any
  example(..._a: any[]): this {
    return this;
  }
  // deno-lint-ignore no-explicit-any
  globalOption(..._a: any[]): this {
    return this;
  }
  // deno-lint-ignore no-explicit-any
  type(..._a: any[]): this {
    return this;
  }
  // deno-lint-ignore no-explicit-any
  alias(..._a: any[]): this {
    return this;
  }
  // deno-lint-ignore no-explicit-any
  help(..._a: any[]): this {
    return this;
  }
  getName(): string {
    return this.#name;
  }
  getVersion(): string {
    return this.#version;
  }
  getDescription(): string {
    return this.#description;
  }
  parse(_args?: string[]): Promise<unknown> {
    throw new Error(
      "@cliffy/command stub: the takosumi CLI is not ported to bun yet (REVIEW: port to commander).",
    );
  }
}

export class EnumType {
  // deno-lint-ignore no-explicit-any
  constructor(..._a: any[]) {}
}

export class StringType {}
export class NumberType {}
export class BooleanType {}

export default { Command, EnumType };
