/**
 * commander `Command` adapted for the Takosumi CLI and the bun test runtime.
 *
 * The CLI was ported from `@cliffy/command` to npm `commander`. Two cliffy call
 * conventions are baked into the CLI tests and must keep working:
 *
 *   1. `cmd.parse(args)` treats `args` as the *user* argument vector (no
 *      `node script` prefix to strip). commander defaults to `from: "node"`
 *      (i.e. `argv.slice(2)`), which would drop the first two user args. This
 *      subclass defaults `parse` / `parseAsync` to `from: "user"`.
 *   2. `.command(name)` builds child commands that inherit these semantics;
 *      overriding `createCommand` makes commander instantiate this subclass for
 *      every `.command(...)` / `.addCommand(...)` child.
 *
 * It also works around a commander-under-`bun test` incompatibility: when the
 * tests run via `bun test`, commander's save/restore of `_optionValues` around
 * parse leaves the post-parse option store empty, so `cmd.opts()` (and the
 * options object commander passes to `.action()`) come back as `{}` even though
 * parsing succeeded. (`bun run` and `deno` are unaffected.) commander's
 * `option:<name>` events DO fire correctly during parse, so we mirror every
 * parsed value into a per-command store and have `opts()` fall back to it
 * whenever commander's native store is empty. When the native store is
 * populated (Node / Deno / `bun run`), we return it unchanged.
 *
 * Every CLI command module imports `Command` from here instead of directly from
 * `commander` so the whole tree shares these semantics.
 */
import {
  Command as CommanderCommand,
  type Option,
  type ParseOptions,
} from "commander";

export class Command extends CommanderCommand {
  /** Option values mirrored from `option:<name>` events during parse. */
  #captured: Record<string, unknown> = {};

  override createCommand(name?: string): Command {
    return new Command(name);
  }

  override addOption(option: Option): this {
    const result = super.addOption(option);
    const attr = option.attributeName();

    // Seed defaults so they survive even when commander's native store is lost.
    if (option.defaultValue !== undefined) {
      this.#captured[attr] = option.defaultValue;
    } else if (option.negate) {
      // `--no-foo` implies `foo` defaults to true.
      this.#captured[attr] = true;
    }

    this.on(`option:${option.name()}`, (value?: string) => {
      this.#captured[attr] = value === undefined ? true : value;
    });
    if (option.negate) {
      // `--no-foo` emits `option:foo` (the positive name) and means false.
      this.on(`option:${option.name().replace(/^no-/, "")}`, () => {
        this.#captured[attr] = false;
      });
    }
    return result;
  }

  override opts<T extends Record<string, unknown> = Record<string, unknown>>(): T {
    const native = super.opts() as Record<string, unknown>;
    if (Object.keys(native).length > 0) {
      return native as T;
    }
    return { ...this.#captured } as T;
  }

  override parse(
    argv?: readonly string[],
    options?: ParseOptions,
  ): this {
    return super.parse(
      argv as string[] | undefined,
      options ?? { from: "user" },
    );
  }

  override parseAsync(
    argv?: readonly string[],
    options?: ParseOptions,
  ): Promise<this> {
    return super.parseAsync(
      argv as string[] | undefined,
      options ?? { from: "user" },
    );
  }
}
