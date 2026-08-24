import type {
  InterfaceInput,
  InterfaceInputProvenance,
  JsonValue,
} from "takosumi-contract";
import type { OpenTofuControlStore } from "../deploy-control/store.ts";
import type {
  InterfaceInputResolver,
  InterfaceResolutionResult,
} from "./service.ts";

type CapsuleOutputResolution =
  | {
      readonly ok: true;
      readonly values: Readonly<Record<string, unknown>>;
      readonly outputId: string;
      readonly outputDigest: string;
      readonly stateVersionId?: string;
      readonly runId?: string;
    }
  | {
      readonly ok: false;
      readonly failure: Extract<InterfaceResolutionResult, { ok: false }>;
    };

/**
 * Resolves Interface inputs from literal values or the current successful
 * OpenTofu Output of another Capsule. Resource/Form output bridges were
 * intentionally removed with the embedded host; this resolver now has one
 * authority and one lifecycle to validate.
 */
export class OutputBackedInterfaceInputResolver
  implements InterfaceInputResolver
{
  constructor(
    readonly options: {
      readonly opentofu: OpenTofuControlStore;
    },
  ) {}

  async resolve(input: {
    readonly workspaceId: string;
    readonly specGeneration: number;
    readonly inputs: Readonly<Record<string, InterfaceInput>>;
  }): Promise<InterfaceResolutionResult> {
    const resolvedInputs: Record<string, JsonValue> = {};
    const provenance: Record<string, InterfaceInputProvenance> = {};
    const capsuleCache = new Map<string, CapsuleOutputResolution>();

    for (const [name, source] of Object.entries(input.inputs)) {
      if (source.source === "literal") {
        resolvedInputs[name] = source.value;
        provenance[name] = {
          source: "literal",
          specGeneration: input.specGeneration,
        };
        continue;
      }
      let snapshot = capsuleCache.get(source.capsuleId);
      if (!snapshot) {
        snapshot = await this.#capsuleOutput(
          input.workspaceId,
          source.capsuleId,
        );
        capsuleCache.set(source.capsuleId, snapshot);
      }
      if (!snapshot.ok) return snapshot.failure;
      const selected = selectOutput(
        snapshot.values,
        source.outputName,
        source.pointer,
      );
      if (!selected.ok) return failure(name, selected.message);
      resolvedInputs[name] = selected.value;
      provenance[name] = {
        source: "capsule_output",
        runId: snapshot.runId,
        stateVersionId: snapshot.stateVersionId,
        outputId: snapshot.outputId,
        outputDigest: snapshot.outputDigest,
        outputName: source.outputName,
        ...(source.pointer === undefined ? {} : { pointer: source.pointer }),
      };
    }

    return { ok: true, resolvedInputs, provenance };
  }

  async #capsuleOutput(
    workspaceId: string,
    capsuleId: string,
  ): Promise<CapsuleOutputResolution> {
    const capsule = await this.options.opentofu.getCapsule(capsuleId);
    if (!capsule || capsule.workspaceId !== workspaceId) {
      return {
        ok: false,
        failure: failureValue(
          "CapsuleNotFound",
          "Capsule output owner was not found",
        ),
      };
    }
    const outputId = capsule.currentOutputId;
    if (!outputId) {
      return {
        ok: false,
        failure: failureValue(
          "OutputUnavailable",
          "Capsule has no successful Output",
        ),
      };
    }
    const output = await this.options.opentofu.getOutput(outputId);
    if (
      !output ||
      output.workspaceId !== workspaceId ||
      output.capsuleId !== capsuleId
    ) {
      return {
        ok: false,
        failure: failureValue(
          "OutputUnavailable",
          "Capsule current Output record was not found",
        ),
      };
    }
    const state = await this.options.opentofu.getLatestStateVersion(
      capsuleId,
      capsule.environment,
    );
    if (!state || state.generation !== output.stateGeneration) {
      return {
        ok: false,
        failure: failureValue(
          "StateVersionUnavailable",
          "Capsule Output is not paired with its current StateVersion",
        ),
      };
    }
    return {
      ok: true,
      values: output.workspaceOutputs,
      outputId: output.id,
      outputDigest: output.outputDigest,
      stateVersionId: state.id,
      ...(state.createdByRunId ? { runId: state.createdByRunId } : {}),
    };
  }
}

function selectOutput(
  outputs: Readonly<Record<string, unknown>>,
  outputName?: string,
  pointer?: string,
):
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly message: string } {
  if (
    outputName !== undefined &&
    !Object.prototype.hasOwnProperty.call(outputs, outputName)
  ) {
    return {
      ok: false,
      message: `output ${outputName} is missing, sensitive, or excluded by output policy`,
    };
  }
  let value: unknown = outputName === undefined ? outputs : outputs[outputName];
  if (pointer !== undefined && pointer !== "") {
    for (const encoded of pointer.slice(1).split("/")) {
      const token = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
      if (Array.isArray(value)) {
        if (!/^(0|[1-9][0-9]*)$/u.test(token)) {
          return {
            ok: false,
            message: `pointer ${pointer} does not select an array index`,
          };
        }
        value = value[Number(token)];
      } else if (isObject(value)) {
        if (!Object.prototype.hasOwnProperty.call(value, token)) {
          return { ok: false, message: `pointer ${pointer} does not exist` };
        }
        value = value[token];
      } else {
        return { ok: false, message: `pointer ${pointer} traverses a scalar` };
      }
    }
  }
  if (value === undefined || !isJsonValue(value)) {
    return {
      ok: false,
      message: `output ${outputName ?? "document"} resolved to a non-JSON value`,
    };
  }
  return { ok: true, value };
}

function failure(
  inputName: string,
  message: string,
): InterfaceResolutionResult {
  return failureValue(
    "InputNotReady",
    `Interface input ${inputName}: ${message}`,
  );
}

function failureValue(
  reason: string,
  message: string,
): Extract<InterfaceResolutionResult, { ok: false }> {
  return { ok: false, phase: "NotReady", reason, message };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  const stack: Array<{ readonly entry: unknown; readonly depth: number }> = [
    { entry: value, depth: 0 },
  ];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const { entry, depth } = stack.pop()!;
    if (depth > 32) return false;
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean"
    ) {
      continue;
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) return false;
      continue;
    }
    if (typeof entry !== "object") return false;
    if (seen.has(entry)) return false;
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (const child of entry) stack.push({ entry: child, depth: depth + 1 });
    } else {
      for (const child of Object.values(entry)) {
        stack.push({ entry: child, depth: depth + 1 });
      }
    }
  }
  return true;
}
