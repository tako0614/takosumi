// runner/lib/runtime_inputs.ts
//
// Run-scoped sensitive provider inputs.
//
// Some providers accept an Apply-only sensitive `map(string)` on their provider
// block. The control plane mints that map and sends it on the dispatch-only
// credential bundle; this module turns it into an OpenTofu ephemeral-variable
// file body and hands it to `tofu` through a FIFO that only `tofu` itself
// reads.
//
// Why a FIFO and not standard input: OpenTofu launches every provider plugin
// with `cmd.Stdin = os.Stdin`, so anything on fd 0 is inherited by — and
// re-readable by — every plugin in the root, including third-party providers
// that are not the declaring instance. Standard input therefore stays unset
// (Bun's default `ignore` ⇒ `/dev/null`), and the body travels through a
// named pipe inside a 0700 directory:
//   - a FIFO holds no bytes at rest, so there is no file to shred and no
//     seekable handle for a same-uid process to re-read from `/proc/<pid>/fd`;
//   - the writer opens it only once `tofu` has opened the read end, writes the
//     whole body once, closes, and the pipe and its directory are removed
//     immediately afterwards;
//   - `-var` is never used, so no value can appear in `ps` output;
//   - `TF_VAR_*` is never set, and the credential lane explicitly reserves it;
//   - every value (and its escaped HCL form) joins
//     `CommandContext.redactionValues`, so a provider that echoes one back is
//     redacted out of runner stdout/stderr.
//
// OpenTofu reads a `-var-file` exactly once per command and requires an
// ephemeral variable set at plan to be set again at apply, so plan and apply
// both supply the same variable — empty at plan/destroy, exact at apply.
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { hclString } from "../../lib/rootgen/src/mod.ts";
import type { SpawnedCommand } from "./exec.ts";
import { RUNNER_REDACTION_MIN_VALUE_LENGTH } from "./redaction.ts";
import type { GeneratedRoot, RuntimeInputsDispatch } from "./types.ts";
import { isRecord, recordField, stringField } from "./util.ts";

/**
 * Reserved generated-root variable namespace. The runner refuses to bind a map
 * to any other variable so a dispatch can never target a Capsule-authored root
 * variable, which would put the values into module state.
 */
const VARIABLE_PREFIX = "takosumi_runtime_inputs__";
const VARIABLE_PATTERN =
  /^takosumi_runtime_inputs__[A-Za-z_][A-Za-z0-9_-]*$/u;
const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MAX_NAMES = 64;
const MAX_VALUE_BYTES = 32768;
const MAX_TOTAL_BYTES = 1024 * 1024;
const NUL = "\u0000";

/**
 * Parses `credentials.runtimeInputs` from a dispatch payload.
 *
 * Like every other credential delivery, an explicit run credential manifest is
 * required: material without a reviewed manifest is never admitted.
 */
export function runtimeInputsFromRequest(
  request: unknown,
): readonly RuntimeInputsDispatch[] {
  const credentials = recordField(request, "credentials");
  if (!isRecord(credentials)) return [];
  const raw = credentials.runtimeInputs;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    invalid("run-scoped sensitive inputs payload is malformed");
  }
  if (!isRecord(recordField(credentials, "manifest"))) {
    invalid(
      "run-scoped sensitive inputs require an explicit run credential manifest",
    );
  }
  const entries = raw.map(exactRuntimeInputs);
  const variableNames = entries.map((entry) => entry.variableName);
  if (new Set(variableNames).size !== variableNames.length) {
    invalid("run-scoped sensitive input variables must be unique");
  }
  let totalBytes = 0;
  for (const entry of entries) {
    for (const value of Object.values(entry.values)) {
      totalBytes += new TextEncoder().encode(value).byteLength;
    }
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    invalid(
      `run-scoped sensitive inputs exceed ${MAX_TOTAL_BYTES} bytes in total`,
    );
  }
  return entries;
}

/**
 * Every delivered value, for the runner's stdout/stderr redaction list.
 *
 * The escaped HCL form is added alongside the raw value: a diagnostic that
 * quotes the variable file back at the operator contains the escaped form, and
 * `redactExactCredentialValues` only matches literal substrings.
 */
export function runtimeInputRedactionValues(
  entries: readonly RuntimeInputsDispatch[],
): string[] {
  return entries.flatMap((entry) =>
    Object.values(entry.values).flatMap((value) => {
      const escaped = hclString(value);
      // `hclString` wraps in quotes; the inner form is what appears inside the
      // variable file body, so redact that too.
      const inner = escaped.slice(1, -1);
      return inner === value ? [value] : [value, inner];
    }),
  );
}

/**
 * Fails closed before `tofu` is spawned when the reviewed generated root does
 * not declare the exact ephemeral variable a dispatch entry targets. Without
 * this, a mismatched dispatch would either be silently ignored by OpenTofu or
 * bound to a variable the reviewer never saw.
 */
export function assertRuntimeInputVariablesDeclared(
  entries: readonly RuntimeInputsDispatch[],
  generatedRoot: GeneratedRoot | undefined,
): void {
  if (entries.length === 0) return;
  if (!generatedRoot) {
    invalid(
      "run-scoped sensitive inputs require a Takosumi-generated root that declares their ephemeral variables",
    );
  }
  const declarations = Object.values(generatedRoot.files).join("\n");
  for (const entry of entries) {
    if (!declarations.includes(`variable ${hclString(entry.variableName)} {`)) {
      invalid(
        `run-scoped sensitive input variable is not declared by the generated root: ${entry.variableName}`,
      );
    }
  }
}

/**
 * A transient `-var-file` this run delivers through a FIFO.
 *
 * `args` is spread into the `tofu` argv; `onSpawn` is handed to `runCommand` so
 * the write end is opened only once the child exists; `delivered` re-raises any
 * delivery failure after the command result is in hand; `dispose` removes the
 * pipe and its directory.
 */
export interface RuntimeInputVariableFile {
  readonly args: readonly string[];
  readonly onSpawn: (child: SpawnedCommand) => void;
  delivered(): Promise<void>;
  dispose(): Promise<void>;
}

const NO_RUNTIME_INPUT_VARIABLE_FILE: RuntimeInputVariableFile = {
  args: [],
  onSpawn: () => {},
  delivered: async () => {},
  dispose: async () => {},
};

/** Bounded wait for `tofu` to open the read end before the run fails closed. */
const VARIABLE_FILE_OPEN_TIMEOUT_MS = 120_000;
const VARIABLE_FILE_POLL_MS = 5;

/**
 * Creates the 0700 directory and the 0600 FIFO this run's variable file travels
 * through. Nothing is written until {@link RuntimeInputVariableFile.onSpawn}
 * reports that `tofu` exists, and nothing is ever stored at rest.
 */
export async function prepareRuntimeInputVariableFile(
  entries: readonly RuntimeInputsDispatch[],
  workspaceRoot: string,
): Promise<RuntimeInputVariableFile> {
  if (entries.length === 0) return NO_RUNTIME_INPUT_VARIABLE_FILE;
  const body = runtimeInputVariableFileBody(entries);
  if (!body) return NO_RUNTIME_INPUT_VARIABLE_FILE;
  // `mkdtemp` creates the directory 0700, and only this process ever names the
  // pipe inside it. A sibling of the run workspace keeps it on the same
  // run-scoped volume the container already owns.
  const directory = await mkdtemp(`${workspaceRoot}-runtime-inputs-`);
  // Not a `.json` name: OpenTofu parses this body as HCL tfvars.
  const path = join(directory, "runtime-inputs.tfvars");
  const made = Bun.spawnSync(["mkfifo", "-m", "600", path]);
  if (made.exitCode !== 0) {
    await rm(directory, { recursive: true, force: true });
    invalid(
      "run-scoped sensitive inputs could not create their transient variable pipe",
    );
  }
  let delivery: Promise<void> | undefined;
  let failure: unknown;
  return {
    args: [`-var-file=${path}`],
    onSpawn: (child) => {
      delivery = feedVariableFile(path, body, child).catch((error: unknown) => {
        failure = error;
      });
    },
    delivered: async () => {
      await delivery;
      if (failure !== undefined) throw failure;
    },
    dispose: async () => {
      await delivery;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/**
 * Opens the write end once `tofu` has opened the read end, writes the whole
 * body, and closes so the reader sees a clean EOF.
 *
 * A FIFO's write-side `open(O_WRONLY | O_NONBLOCK)` fails with `ENXIO` until a
 * reader exists, which is exactly the signal this loop waits for. It stops the
 * moment the child dies: a child that failed carries its own diagnostic, while
 * a child that succeeded without ever reading the file means OpenTofu silently
 * ignored the variable, so that case fails the run.
 */
async function feedVariableFile(
  path: string,
  body: Uint8Array,
  child: SpawnedCommand,
): Promise<void> {
  let exitCode: number | undefined;
  void child.exited.then(
    (code) => {
      exitCode = code;
    },
    () => {
      exitCode = -1;
    },
  );
  const deadline = Date.now() + VARIABLE_FILE_OPEN_TIMEOUT_MS;
  let handle: FileHandle | undefined;
  while (handle === undefined) {
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      if (errorCode(error) !== "ENXIO") throw error;
      if (exitCode !== undefined) {
        if (exitCode === 0) {
          invalid(
            "run-scoped sensitive inputs were never read: OpenTofu exited successfully without opening its variable file",
          );
        }
        return;
      }
      if (Date.now() > deadline) {
        invalid(
          "run-scoped sensitive inputs were not read by OpenTofu before the delivery deadline",
        );
      }
      await Bun.sleep(VARIABLE_FILE_POLL_MS);
    }
  }
  try {
    let written = 0;
    while (written < body.byteLength) {
      try {
        const result = await handle.write(
          body,
          written,
          body.byteLength - written,
        );
        written += result.bytesWritten;
      } catch (error) {
        const code = errorCode(error);
        if (code === "EAGAIN") {
          if (Date.now() > deadline) {
            invalid(
              "run-scoped sensitive inputs were not drained by OpenTofu before the delivery deadline",
            );
          }
          await Bun.sleep(VARIABLE_FILE_POLL_MS);
          continue;
        }
        if (code === "EPIPE" && (await child.exited) !== 0) return;
        throw error;
      }
    }
  } finally {
    await handle.close();
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

/**
 * Renders the transient HCL variable-file body. `hclString` neutralizes `${`
 * and `%{`, so no value can open an interpolation or template directive inside
 * the generated body.
 */
export function runtimeInputVariableFileBody(
  entries: readonly RuntimeInputsDispatch[],
): Uint8Array | undefined {
  if (entries.length === 0) return undefined;
  const blocks = [...entries]
    .sort((left, right) => left.variableName.localeCompare(right.variableName))
    .map((entry) => {
      const names = Object.keys(entry.values).sort();
      if (names.length === 0) return `${entry.variableName} = {}`;
      return [
        `${entry.variableName} = {`,
        ...names.map(
          (name) => `  ${hclString(name)} = ${hclString(entry.values[name]!)}`,
        ),
        "}",
      ].join("\n");
    });
  return new TextEncoder().encode(`${blocks.join("\n")}\n`);
}

function exactRuntimeInputs(value: unknown): RuntimeInputsDispatch {
  if (!isRecord(value) || !hasExactKeys(value, ["variableName", "names", "values"])) {
    invalid("run-scoped sensitive inputs entry is malformed");
  }
  const variableName = stringField(value, "variableName");
  if (
    variableName === undefined ||
    !variableName.startsWith(VARIABLE_PREFIX) ||
    !VARIABLE_PATTERN.test(variableName)
  ) {
    invalid("run-scoped sensitive input variable name is unsafe");
  }
  const declaredNames = value.names;
  if (
    !Array.isArray(declaredNames) ||
    declaredNames.length < 1 ||
    declaredNames.length > MAX_NAMES ||
    declaredNames.some(
      (name) => typeof name !== "string" || !NAME_PATTERN.test(name),
    )
  ) {
    invalid("run-scoped sensitive input names are malformed");
  }
  const names = [...(declaredNames as string[])];
  const sorted = [...names].sort();
  if (
    new Set(sorted).size !== sorted.length ||
    sorted.some((name, index) => name !== names[index])
  ) {
    invalid("run-scoped sensitive input names must be sorted and unique");
  }
  const rawValues = value.values;
  if (!isRecord(rawValues)) {
    invalid("run-scoped sensitive input values are malformed");
  }
  const valueNames = Object.keys(rawValues).sort();
  // A plan or destroy delivers no values; an apply delivers exactly the
  // declared set. Any other shape means the mint and the reviewed name set
  // disagree, so the run stops rather than applying a partial map.
  if (
    valueNames.length !== 0 &&
    (valueNames.length !== sorted.length ||
      valueNames.some((name, index) => name !== sorted[index]))
  ) {
    invalid("run-scoped sensitive input values do not match their names");
  }
  const values: Record<string, string> = {};
  for (const name of valueNames) {
    const item = rawValues[name];
    if (typeof item !== "string" || item.length === 0 || item.includes(NUL)) {
      invalid("run-scoped sensitive input value is malformed");
    }
    // Anything shorter than the redaction floor could not be stripped out of
    // runner stdout/stderr if a provider echoed it back.
    if (item.length < RUNNER_REDACTION_MIN_VALUE_LENGTH) {
      invalid(
        `run-scoped sensitive input value is shorter than the ${RUNNER_REDACTION_MIN_VALUE_LENGTH}-character redaction floor`,
      );
    }
    if (new TextEncoder().encode(item).byteLength > MAX_VALUE_BYTES) {
      invalid(
        `run-scoped sensitive input value exceeds ${MAX_VALUE_BYTES} bytes`,
      );
    }
    values[name] = item;
  }
  return { variableName, names: sorted, values };
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function invalid(message: string): never {
  throw new Error(message);
}
