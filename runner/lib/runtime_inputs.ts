// runner/lib/runtime_inputs.ts
//
// Run-scoped sensitive provider inputs.
//
// Some providers accept an Apply-only sensitive `map(string)` on their provider
// block. The control plane mints that map and sends it on the dispatch-only
// credential bundle; this module turns it into an OpenTofu ephemeral-variable
// file body that the runner writes to the `tofu` process's STANDARD INPUT.
//
// Nothing here ever reaches a file, an argv element, or an environment
// variable:
//   - `-var` is never used, so no value can appear in `ps` output;
//   - `TF_VAR_*` is never set, and the credential lane explicitly reserves it;
//   - the body goes to `/dev/stdin`, so no plaintext touches the filesystem and
//     there is no shred path to fail;
//   - every value joins `CommandContext.redactionValues`, so a provider that
//     echoes one back is redacted out of runner stdout/stderr.
//
// OpenTofu reads a `-var-file` exactly once per command and requires an
// ephemeral variable set at plan to be set again at apply, so plan and apply
// both supply the same variable — empty at plan/destroy, exact at apply.
import { hclString } from "../../lib/rootgen/src/mod.ts";
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

/** Every delivered value, for the runner's stdout/stderr redaction list. */
export function runtimeInputRedactionValues(
  entries: readonly RuntimeInputsDispatch[],
): string[] {
  return entries.flatMap((entry) => Object.values(entry.values));
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
 * Renders the transient HCL variable-file body handed to `tofu` on standard
 * input. `hclString` neutralizes `${` and `%{`, so no value can open an
 * interpolation or template directive inside the generated body.
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
