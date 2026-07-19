import Ajv2020 from "ajv/dist/2020.js";
import type {
  ActorContext,
  FormInterfaceDescriptor,
  FormInterfaceInputDeclaration,
  InstalledFormReference,
  Interface,
  InterfaceInput,
  InterfaceSpec,
  JsonObject,
} from "takosumi-contract";
import { formRefKey, isPortableInterfaceInputSource } from "takosumi-contract";
import { sha256HexAsync } from "../../shared/runtime/hash.ts";
import { InterfaceService, InterfaceServiceError } from "./service.ts";

export type FormDescriptorSkipReason =
  "unsupported_source" | "name_taken" | "document_invalid" | "input_not_ready";

export class RequiredFormInterfaceError extends Error {
  constructor(
    readonly descriptorName: string,
    readonly descriptorVersion: string,
    readonly reason: FormDescriptorSkipReason,
  ) {
    super(
      `required Interface ${descriptorName}@${descriptorVersion} could not become Ready: ${reason}`,
    );
    this.name = "RequiredFormInterfaceError";
  }
}

export interface FormDescriptorMaterializationInput {
  readonly interfaces: InterfaceService;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly form: InstalledFormReference;
  readonly descriptors: readonly FormInterfaceDescriptor[];
  readonly actor?: ActorContext;
}

export interface FormDescriptorMaterializationResult {
  readonly materialized: readonly Interface[];
  readonly skipped: readonly {
    readonly name: string;
    readonly version: string;
    readonly required: boolean;
    readonly reason: FormDescriptorSkipReason;
  }[];
}

/**
 * Materialize verified portable descriptors as ordinary host-owned Interfaces.
 * No binding is created: declaration and authorization remain separate.
 */
export async function ensureFormDescriptorInterfaces(
  input: FormDescriptorMaterializationInput,
): Promise<FormDescriptorMaterializationResult> {
  const exactFormKey = formRefKey(input.form.formRef);
  const history = [
    ...(await input.interfaces.list({
      workspaceId: input.workspaceId,
      ownerKind: "Resource",
      ownerId: input.resourceId,
      includeRetired: true,
    })),
  ];
  const materialized: Interface[] = [];
  const skipped: FormDescriptorMaterializationResult["skipped"][number][] = [];

  for (const descriptor of input.descriptors) {
    const required = descriptor.required === true;
    const lineage = {
      formRefKey: exactFormKey,
      formSchemaDigest: input.form.formRef.schemaDigest,
      descriptorName: descriptor.name,
      descriptorVersion: descriptor.version,
    };
    const document = descriptor.document ?? {};
    if (!validDocument(document, descriptor.documentSchema)) {
      if (required) {
        throw new RequiredFormInterfaceError(
          descriptor.name,
          descriptor.version,
          "document_invalid",
        );
      }
      skipped.push({
        name: descriptor.name,
        version: descriptor.version,
        required,
        reason: "document_invalid",
      });
      continue;
    }
    const inputs = translateInputs(input.resourceId, descriptor.inputs ?? []);
    if (!inputs.ok) {
      if (required) {
        throw new RequiredFormInterfaceError(
          descriptor.name,
          descriptor.version,
          "unsupported_source",
        );
      }
      skipped.push({
        name: descriptor.name,
        version: descriptor.version,
        required,
        reason: "unsupported_source",
      });
      continue;
    }

    const desiredSpec: InterfaceSpec = {
      type: descriptor.name,
      version: descriptor.version,
      document,
      ...(Object.keys(inputs.value).length > 0 ? { inputs: inputs.value } : {}),
      access: { visibility: "workspace" },
    };
    const name = await descriptorRecordName(descriptor);
    const existingIndex = history.findIndex((record) => {
      const source = record.metadata.materializedFrom;
      return (
        source?.source === "form_descriptor" &&
        source.formRefKey === lineage.formRefKey &&
        source.formSchemaDigest === lineage.formSchemaDigest &&
        source.descriptorName === lineage.descriptorName &&
        source.descriptorVersion === lineage.descriptorVersion &&
        record.status.phase !== "Retired"
      );
    });
    const existing = existingIndex === -1 ? undefined : history[existingIndex];
    if (
      existing &&
      existing.metadata.name === name &&
      interfaceSpecsEqual(existing.spec, desiredSpec)
    ) {
      const reconciled =
        existing.status.phase === "Resolved"
          ? existing
          : await input.interfaces.reconcile(existing.metadata.id);
      if (required && reconciled.status.phase !== "Resolved") {
        throw new RequiredFormInterfaceError(
          descriptor.name,
          descriptor.version,
          "input_not_ready",
        );
      }
      materialized.push(reconciled);
      continue;
    }
    if (existing) {
      history[existingIndex] = await retireStaleDescriptor(
        input.interfaces,
        existing,
      );
    }

    const nameTaken = history.some(
      (record) =>
        record.metadata.name === name && record.status.phase !== "Retired",
    );
    if (nameTaken) {
      if (required) {
        throw new RequiredFormInterfaceError(
          descriptor.name,
          descriptor.version,
          "name_taken",
        );
      }
      skipped.push({
        name: descriptor.name,
        version: descriptor.version,
        required,
        reason: "name_taken",
      });
      continue;
    }

    let created: Interface;
    try {
      created = await input.interfaces.create(
        {
          workspaceId: input.workspaceId,
          name,
          ownerRef: { kind: "Resource", id: input.resourceId },
          spec: desiredSpec,
        },
        input.actor,
        lineage,
      );
    } catch (error) {
      if (
        !(error instanceof InterfaceServiceError) ||
        error.code !== "already_exists"
      ) {
        throw error;
      }
      const winner = (
        await input.interfaces.list({
          workspaceId: input.workspaceId,
          ownerKind: "Resource",
          ownerId: input.resourceId,
          includeRetired: false,
        })
      ).find((record) => {
        const source = record.metadata.materializedFrom;
        return (
          record.metadata.name === name &&
          source?.source === "form_descriptor" &&
          descriptorLineageKey(source) === descriptorLineageKey(lineage) &&
          interfaceSpecsEqual(record.spec, desiredSpec)
        );
      });
      if (!winner) throw error;
      created =
        winner.status.phase === "Resolved"
          ? winner
          : await input.interfaces.reconcile(winner.metadata.id);
    }
    if (required && created.status.phase !== "Resolved") {
      throw new RequiredFormInterfaceError(
        descriptor.name,
        descriptor.version,
        "input_not_ready",
      );
    }
    materialized.push(created);
    history.push(created);
  }

  const desiredLineages = new Set(
    input.descriptors.map((descriptor) =>
      descriptorLineageKey({
        formRefKey: exactFormKey,
        formSchemaDigest: input.form.formRef.schemaDigest,
        descriptorName: descriptor.name,
        descriptorVersion: descriptor.version,
      }),
    ),
  );
  for (const record of history) {
    const source = record.metadata.materializedFrom;
    if (
      source?.source !== "form_descriptor" ||
      record.status.phase === "Retired" ||
      desiredLineages.has(descriptorLineageKey(source))
    ) {
      continue;
    }
    await retireStaleDescriptor(input.interfaces, record);
  }

  return { materialized, skipped };
}

function descriptorLineageKey(input: {
  readonly formRefKey: string;
  readonly formSchemaDigest: string;
  readonly descriptorName: string;
  readonly descriptorVersion: string;
}): string {
  return [
    input.formRefKey,
    input.formSchemaDigest,
    input.descriptorName,
    input.descriptorVersion,
  ].join("\0");
}

async function retireStaleDescriptor(
  interfaces: InterfaceService,
  initial: Interface,
): Promise<Interface> {
  let current = initial;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (current.status.phase === "Retired") return current;
    try {
      return await interfaces.retire(
        current.metadata.id,
        current.metadata.generation,
      );
    } catch (error) {
      if (
        !(error instanceof InterfaceServiceError) ||
        error.code !== "conflict"
      )
        throw error;
      current = await interfaces.get(current.metadata.id);
    }
  }
  throw new InterfaceServiceError(
    "conflict",
    "stale Form descriptor Interface changed during retirement",
  );
}

function interfaceSpecsEqual(
  left: InterfaceSpec,
  right: InterfaceSpec,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function descriptorRecordName(
  descriptor: FormInterfaceDescriptor,
): Promise<string> {
  const identity = `${descriptor.name}\0${descriptor.version}`;
  const digest = await sha256HexAsync(new TextEncoder().encode(identity));
  const readable = descriptor.name.slice(0, 94);
  return `form.${readable}.${digest.slice(0, 24)}`;
}

function validDocument(
  document: JsonObject,
  schema: JsonObject | undefined,
): boolean {
  if (!schema) return true;
  try {
    return (
      new Ajv2020({
        allErrors: true,
        strict: false,
        validateFormats: false,
      }).compile(schema)(document) === true
    );
  } catch {
    return false;
  }
}

function translateInputs(
  resourceId: string,
  declarations: readonly FormInterfaceInputDeclaration[],
):
  | { readonly ok: true; readonly value: Record<string, InterfaceInput> }
  | { readonly ok: false } {
  const inputs: Record<string, InterfaceInput> = {};
  for (const declaration of declarations) {
    if (!isPortableInterfaceInputSource(declaration.source))
      return { ok: false };
    if (declaration.source === "literal") {
      if (declaration.value === undefined) return { ok: false };
      inputs[declaration.name] = {
        source: "literal",
        value: declaration.value,
      };
      continue;
    }
    const pointer = declaration.pointer;
    if (pointer === undefined || pointer === "") {
      inputs[declaration.name] = { source: "resource_output", resourceId };
      continue;
    }
    const encodedTokens = pointer.slice(1).split("/");
    const outputName = decodePointerToken(encodedTokens[0]!);
    if (outputName === "") return { ok: false };
    inputs[declaration.name] = {
      source: "resource_output",
      resourceId,
      outputName,
      ...(encodedTokens.length > 1
        ? { pointer: `/${encodedTokens.slice(1).join("/")}` }
        : {}),
    };
  }
  return { ok: true, value: inputs };
}

function decodePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}
