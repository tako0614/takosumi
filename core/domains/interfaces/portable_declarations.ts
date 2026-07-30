import type {
  ActorContext,
  FormInterfaceDescriptor,
  Interface,
  InterfaceSpec,
  JsonObject,
  ResourceObject,
  TakoformDeclaredInterface,
} from "takosumi-contract";
import {
  formRefKey,
  formRefOfInstalled,
  isPortableInterfaceInputSource,
  isValidInterfaceName,
} from "takosumi-contract";
import type { Page, PageParams } from "takosumi-contract/pagination";
import { formatResourceShapeId } from "../resource-shape/records.ts";
import type { InterfaceService } from "./service.ts";
import { InterfaceServiceError } from "./service.ts";
import type { ResourceInterfaceWorkspaceResolver } from "./output_resolver.ts";
import type { FormInterfaceResourceUriResolver } from "./form_descriptor_materialization.ts";
import { translatePortableInterfaceInputs } from "./form_descriptor_materialization.ts";
import { InterpretedDraft202012Validator } from "../../shared/json-schema/draft_2020.ts";
import { sha256HexAsync } from "../../shared/runtime/hash.ts";
import { assertTakoformPortableDataOnly } from "../../adapters/takoform/package_verifier.ts";
import { canonicalInterfaceOAuth2ResourceUri } from "./oauth_resource.ts";

const RESOURCE_PAGE_LIMIT = 51;
const RESOURCE_READ_LIMIT = 50;
const INTERFACE_READ_LIMIT = 500;

export class PortableDeclarationReadLimitError extends Error {
  constructor() {
    super(
      "interface declaration query is too broad; provide an exact Resource selector",
    );
    this.name = "PortableDeclarationReadLimitError";
  }
}

export interface PortableDeclarationReaderOptions {
  readonly interfaces: InterfaceService;
  readonly listResources: (
    space: string,
    page: PageParams,
  ) => Promise<Page<ResourceObject>>;
  readonly getResource: (
    space: string,
    kind: string,
    name: string,
  ) => Promise<ResourceObject | undefined>;
  readonly resolveWorkspace: ResourceInterfaceWorkspaceResolver;
  /** Idempotent lazy repair for Ready Resources created before this feature. */
  readonly ensureResourceDeclarations?: (
    resource: ResourceObject,
  ) => Promise<void>;
  /**
   * Optional host runtime location projected as the portable Interface
   * `resourceUri`. It never enters the Form's closed Resource output document.
   */
  readonly resolveResourceUri?: FormInterfaceResourceUriResolver;
}

export interface PortableDeclarationFilter {
  readonly actor: ActorContext;
  readonly space: string;
  readonly name?: string;
  readonly version?: string;
  readonly resourceKind?: string;
  readonly resourceName?: string;
}

export interface PortableDeclarationWriteInput {
  readonly actor: ActorContext;
  readonly space: string;
  readonly declaration: TakoformDeclaredInterface;
  /** Zero means create with If-None-Match; positive values are If-Match. */
  readonly expectedGeneration: number;
}

export interface PortableDeclarationDeleteInput {
  readonly actor: ActorContext;
  readonly space: string;
  readonly name: string;
  readonly version: string;
  readonly resourceKind: string;
  readonly resourceName: string;
  readonly expectedGeneration: number;
}

export interface PortableDeclarationWriterOptions {
  readonly interfaces: InterfaceService;
  readonly getResource: (
    space: string,
    kind: string,
    name: string,
  ) => Promise<ResourceObject | undefined>;
  readonly resolveWorkspace: ResourceInterfaceWorkspaceResolver;
  readonly resolveResourceUri?: FormInterfaceResourceUriResolver;
  /** Service-side binding hydration after the IaC-owned body is durable. */
  readonly ensureBindings?: (input: {
    readonly interface: Interface;
    readonly resource: ResourceObject;
    readonly workspaceId: string;
  }) => Promise<void>;
}

/** Read-only projection over the canonical Interface ledger. */
export function createPortableDeclarationReader(
  options: PortableDeclarationReaderOptions,
) {
  return {
    async listDeclaredInterfaces(
      input: PortableDeclarationFilter,
    ): Promise<readonly TakoformDeclaredInterface[]> {
      const declared: TakoformDeclaredInterface[] = [];
      const workspaceByResource = new Map<
        string,
        Promise<string | undefined>
      >();
      const resourcesByWorkspace = new Map<
        string,
        Map<string, ResourceObject>
      >();
      const exactResource =
        input.resourceKind && input.resourceName
          ? await options.getResource(
              input.space,
              input.resourceKind,
              input.resourceName,
            )
          : undefined;
      const resources: ResourceObject[] = exactResource ? [exactResource] : [];
      if (!input.resourceKind || !input.resourceName) {
        let scanned = 0;
        let cursor: string | undefined;
        do {
          const page = await options.listResources(input.space, {
            limit: RESOURCE_PAGE_LIMIT,
            ...(cursor ? { cursor } : {}),
          });
          scanned += page.items.length;
          if (scanned > RESOURCE_READ_LIMIT || page.nextCursor) {
            throw new PortableDeclarationReadLimitError();
          }
          resources.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);
      }

      for (const resource of resources) {
        if (
          !resource.form ||
          resource.status?.phase !== "Ready" ||
          resource.status.observedGeneration !== resource.metadata.generation
        ) {
          continue;
        }
        const resourceId = formatResourceShapeId(
          resource.metadata.space,
          resource.kind,
          resource.metadata.name,
        );
        let workspace = workspaceByResource.get(resourceId);
        if (!workspace) {
          workspace = options.resolveWorkspace({
            resourceSpaceId: resource.metadata.space,
            resourceId,
          });
          workspaceByResource.set(resourceId, workspace);
        }
        const workspaceId = await workspace;
        if (!workspaceId) continue;
        // A scoped principal may never use a caller-chosen portable Space to
        // cross the explicit Resource Space -> Workspace bridge. Hosts with
        // unscoped operator actors retain their existing policy boundary.
        if (
          input.actor.workspaceId !== undefined &&
          input.actor.workspaceId !== workspaceId
        ) {
          continue;
        }
        // Broad reads stay read-only. An exact Resource read is the bounded
        // lazy-repair boundary for a missed lifecycle observer.
        if (input.resourceKind && input.resourceName) {
          await options.ensureResourceDeclarations?.(resource);
        }
        let resources = resourcesByWorkspace.get(workspaceId);
        if (!resources) {
          resources = new Map();
          resourcesByWorkspace.set(workspaceId, resources);
        }
        resources.set(resourceId, resource);
      }

      for (const [workspaceId, resources] of resourcesByWorkspace) {
        const owned = await options.interfaces.list({
          workspaceId,
          ownerKind: "Resource",
          ownerIds: [...resources.keys()],
          ...(input.name ? { type: input.name } : {}),
          phase: "Resolved",
          limit: INTERFACE_READ_LIMIT + 1,
          includeRetired: false,
        });
        if (owned.length > INTERFACE_READ_LIMIT) {
          throw new PortableDeclarationReadLimitError();
        }
        for (const iface of owned) {
          const resource = resources.get(iface.metadata.ownerRef.id);
          if (!resource) continue;
          const projected = await projectDeclaration(
            iface,
            resource,
            workspaceId,
            options.resolveResourceUri,
          );
          if (!projected) continue;
          if (input.name !== undefined && projected.name !== input.name)
            continue;
          if (
            input.version !== undefined &&
            projected.version !== input.version
          )
            continue;
          declared.push(projected);
        }
      }

      return declared.sort(
        (left, right) =>
          left.resource.kind.localeCompare(right.resource.kind) ||
          left.resource.name.localeCompare(right.resource.name) ||
          left.name.localeCompare(right.name) ||
          left.version.localeCompare(right.version),
      );
    },
  };
}

/**
 * Generic portable write facade over the canonical Interface ledger.
 * Protocol-specific document fields remain opaque and no binding is created.
 */
export function createPortableDeclarationWriter(
  options: PortableDeclarationWriterOptions,
) {
  return {
    async putDeclaredInterface(
      input: PortableDeclarationWriteInput,
    ): Promise<TakoformDeclaredInterface> {
      const declaration = normalizeWritableDeclaration(input.declaration);
      validateWritableInputs(declaration);
      validatePortableDataOnly(declaration);
      const owned = await writableResource(options, {
        actor: input.actor,
        space: input.space,
        kind: declaration.resource.kind,
        name: declaration.resource.name,
      });
      const descriptor: FormInterfaceDescriptor = {
        name: declaration.name,
        version: declaration.version,
        document: declaration.document,
        ...(declaration.documentSchema
          ? { documentSchema: declaration.documentSchema }
          : {}),
        ...(declaration.inputs ? { inputs: declaration.inputs } : {}),
        ...(declaration.resourceUriInput
          ? { resourceUriInput: declaration.resourceUriInput }
          : {}),
      };
      validatePortablePointers(descriptor);
      if (descriptor.documentSchema) {
        try {
          if (
            !new InterpretedDraft202012Validator(
              descriptor.documentSchema,
            ).validate(descriptor.document ?? {})
          ) {
            throw new InterfaceServiceError(
              "invalid_argument",
              "Interface document does not satisfy documentSchema",
            );
          }
        } catch (error) {
          if (error instanceof InterfaceServiceError) throw error;
          throw new InterfaceServiceError(
            "invalid_argument",
            "Interface documentSchema is not a supported Draft 2020-12 schema",
          );
        }
      }
      const resourceUri =
        descriptor.inputs?.some((item) => item.source === "resource_uri") &&
        options.resolveResourceUri &&
        owned.resource.form
          ? await options.resolveResourceUri({
              workspaceId: owned.workspaceId,
              resourceId: owned.resourceId,
              form: owned.resource.form,
              descriptorName: descriptor.name,
              descriptorVersion: descriptor.version,
            })
          : undefined;
      const translated = await translatePortableInterfaceInputs(
        owned.resourceId,
        descriptor,
        resourceUri,
      );
      if (!translated.ok) {
        throw new InterfaceServiceError(
          "failed_precondition",
          `Interface inputs are not ready: ${translated.reason}`,
        );
      }
      const spec: InterfaceSpec = {
        type: descriptor.name,
        version: descriptor.version,
        document: descriptor.document ?? {},
        ...(descriptor.documentSchema
          ? { documentSchema: descriptor.documentSchema }
          : {}),
        ...(Object.keys(translated.value).length > 0
          ? { inputs: translated.value }
          : {}),
        access: {
          visibility: "workspace",
          ...(descriptor.resourceUriInput
            ? { resourceUriInput: descriptor.resourceUriInput }
            : {}),
        },
      };
      const history = await options.interfaces.list({
        workspaceId: owned.workspaceId,
        ownerKind: "Resource",
        ownerId: owned.resourceId,
        includeRetired: true,
      });
      const existing = history.find((iface) =>
        isPortableIacIdentity(iface, descriptor.name, descriptor.version),
      );
      let written: Interface;
      if (existing && existing.status.phase !== "Retired") {
        if (input.expectedGeneration === 0) {
          if (!sameInterfaceSpec(existing.spec, spec)) {
            throw new InterfaceServiceError(
              "already_exists",
              "portable Interface declaration already exists",
            );
          }
          written = existing;
        } else if (existing.metadata.generation !== input.expectedGeneration) {
          if (
            existing.metadata.generation > input.expectedGeneration &&
            sameInterfaceSpec(existing.spec, spec)
          ) {
            written = existing;
          } else {
            throw new InterfaceServiceError(
              "conflict",
              "portable Interface resourceVersion changed",
            );
          }
        } else if (sameInterfaceSpec(existing.spec, spec)) {
          written = existing;
        } else {
          written = await options.interfaces.update(
            existing.metadata.id,
            { spec },
            input.expectedGeneration,
            input.actor,
            undefined,
            "portable_iac",
          );
        }
      } else {
        if (input.expectedGeneration !== 0) {
          throw new InterfaceServiceError(
            "not_found",
            "portable Interface declaration was not found",
          );
        }
        written = await options.interfaces.create(
          {
            workspaceId: owned.workspaceId,
            name: await portableIacRecordName(
              descriptor.name,
              descriptor.version,
            ),
            ownerRef: { kind: "Resource", id: owned.resourceId },
            spec,
          },
          input.actor,
          {
            portableIac: true,
            descriptorName: descriptor.name,
            descriptorVersion: descriptor.version,
          },
        );
      }
      if (written.status.phase !== "Resolved") {
        throw new InterfaceServiceError(
          "failed_precondition",
          "portable Interface declaration inputs are not Resolved",
        );
      }
      await options.ensureBindings?.({
        interface: written,
        resource: owned.resource,
        workspaceId: owned.workspaceId,
      });
      const projected = await projectDeclaration(
        written,
        owned.resource,
        owned.workspaceId,
        options.resolveResourceUri,
      );
      if (!projected) {
        throw new InterfaceServiceError(
          "failed_precondition",
          "portable Interface declaration is not visible",
        );
      }
      return projected;
    },

    async deleteDeclaredInterface(
      input: PortableDeclarationDeleteInput,
    ): Promise<void> {
      const owned = await writableResource(options, {
        actor: input.actor,
        space: input.space,
        kind: input.resourceKind,
        name: input.resourceName,
      });
      const history = await options.interfaces.list({
        workspaceId: owned.workspaceId,
        ownerKind: "Resource",
        ownerId: owned.resourceId,
        includeRetired: true,
      });
      const current = history.find((iface) =>
        isPortableIacIdentity(iface, input.name, input.version),
      );
      if (!current || current.status.phase === "Retired") return;
      if (current.metadata.generation !== input.expectedGeneration) {
        throw new InterfaceServiceError(
          "conflict",
          "portable Interface resourceVersion changed",
        );
      }
      await options.interfaces.retire(
        current.metadata.id,
        current.metadata.generation,
        input.actor,
        undefined,
        "portable_iac",
      );
    },
  };
}

async function projectDeclaration(
  iface: Interface,
  resource: ResourceObject,
  workspaceId: string,
  resolveResourceUri: FormInterfaceResourceUriResolver | undefined,
): Promise<TakoformDeclaredInterface | undefined> {
  if (
    resource.status?.phase !== "Ready" ||
    resource.status.observedGeneration !== resource.metadata.generation
  ) {
    return undefined;
  }
  if (iface.status.phase !== "Resolved") return undefined;
  if (iface.spec.access.visibility === "private") return undefined;
  const lineage = iface.metadata.materializedFrom;
  if (
    lineage?.source !== "form_descriptor" &&
    lineage?.source !== "portable_iac"
  )
    return undefined;
  if (lineage.source === "form_descriptor") {
    if (
      !resource.form ||
      lineage.formRefKey !== formRefKey(formRefOfInstalled(resource.form)) ||
      lineage.formSchemaDigest !== resource.form.schemaDigest
    )
      return undefined;
  }
  if (
    lineage.descriptorName !== iface.spec.type ||
    lineage.descriptorVersion !== iface.spec.version
  )
    return undefined;
  const document = isJsonObject(iface.spec.document)
    ? iface.spec.document
    : undefined;
  const values = iface.status.resolvedInputs
    ? ({ ...iface.status.resolvedInputs } as JsonObject)
    : undefined;
  const inputs = portableInputsOf(iface);
  const resourceUriInput = iface.spec.access.resourceUriInput;
  let resourceUri =
    resourceUriInput && typeof values?.[resourceUriInput] === "string"
      ? (values[resourceUriInput] as string)
      : undefined;
  if (
    resourceUri === undefined &&
    lineage.source === "form_descriptor" &&
    resource.form &&
    resolveResourceUri
  ) {
    resourceUri = canonicalInterfaceOAuth2ResourceUri(
      await resolveResourceUri({
        workspaceId,
        resourceId: iface.metadata.ownerRef.id,
        form: resource.form,
        descriptorName: lineage.descriptorName,
        descriptorVersion: lineage.descriptorVersion,
      }),
    );
  }
  return {
    name: lineage.descriptorName,
    version: lineage.descriptorVersion,
    resource: { kind: resource.kind, name: resource.metadata.name },
    ...(document ? { document } : {}),
    ...(iface.spec.documentSchema
      ? { documentSchema: iface.spec.documentSchema }
      : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
    ...(resourceUriInput ? { resourceUriInput } : {}),
    ...(values ? { values } : {}),
    ...(resourceUri ? { resourceUri } : {}),
    resourceVersion: String(iface.metadata.generation),
    ...(lineage.source === "form_descriptor" && resource.form
      ? { form: resource.form }
      : {}),
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWritableDeclaration(
  declaration: TakoformDeclaredInterface,
): TakoformDeclaredInterface & { readonly document: JsonObject } {
  if (
    !declaration ||
    typeof declaration.name !== "string" ||
    typeof declaration.version !== "string" ||
    !declaration.resource ||
    typeof declaration.resource.kind !== "string" ||
    typeof declaration.resource.name !== "string" ||
    !isJsonObject(declaration.document)
  ) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "portable Interface requires exact identity, Resource, and document object",
    );
  }
  if (
    !isValidInterfaceName(declaration.name) ||
    declaration.version.trim() !== declaration.version ||
    declaration.version.length > 256 ||
    /\s/u.test(declaration.version)
  ) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "portable Interface name or version is invalid",
    );
  }
  return { ...declaration, document: declaration.document };
}

function validateWritableInputs(declaration: TakoformDeclaredInterface): void {
  const inputs = declaration.inputs ?? [];
  if (!Array.isArray(inputs) || inputs.length > 64) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "portable Interface inputs must contain at most 64 entries",
    );
  }
  const names = new Set<string>();
  let resourceUriInputs = 0;
  for (const candidate of inputs as readonly unknown[]) {
    if (!isJsonObject(candidate)) {
      throw new InterfaceServiceError(
        "invalid_argument",
        "portable Interface input must be an object",
      );
    }
    for (const key of Object.keys(candidate)) {
      if (!["name", "source", "pointer", "value"].includes(key)) {
        throw new InterfaceServiceError(
          "invalid_argument",
          `portable Interface input field ${key} is unsupported`,
        );
      }
    }
    if (
      !isValidInterfaceName(candidate.name) ||
      typeof candidate.source !== "string" ||
      names.has(candidate.name)
    ) {
      throw new InterfaceServiceError(
        "invalid_argument",
        "portable Interface input identity is invalid or duplicated",
      );
    }
    names.add(candidate.name);
    if (
      candidate.pointer !== undefined &&
      typeof candidate.pointer !== "string"
    ) {
      throw new InterfaceServiceError(
        "invalid_argument",
        `Interface input ${candidate.name} pointer must be a string`,
      );
    }
    if (!isPortableInterfaceInputSource(candidate.source)) {
      throw new InterfaceServiceError(
        "invalid_argument",
        `Interface input ${candidate.name} uses an unsupported source`,
      );
    }
    if (candidate.source === "literal") {
      if (
        !Object.prototype.hasOwnProperty.call(candidate, "value") ||
        candidate.pointer !== undefined
      ) {
        throw new InterfaceServiceError(
          "invalid_argument",
          `literal Interface input ${candidate.name} requires value and forbids pointer`,
        );
      }
    } else if (candidate.value !== undefined) {
      throw new InterfaceServiceError(
        "invalid_argument",
        `Interface input ${candidate.name} must not carry value`,
      );
    }
    if (candidate.source === "resource_uri") {
      resourceUriInputs += 1;
      if (candidate.pointer !== undefined) {
        throw new InterfaceServiceError(
          "invalid_argument",
          `resource_uri Interface input ${candidate.name} must not carry pointer`,
        );
      }
    }
  }
  if (
    (declaration.resourceUriInput === undefined && resourceUriInputs !== 0) ||
    (declaration.resourceUriInput !== undefined &&
      (resourceUriInputs !== 1 ||
        !inputs.some(
          (candidate) =>
            candidate.source === "resource_uri" &&
            candidate.name === declaration.resourceUriInput,
        )))
  ) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "resourceUriInput must name the single resource_uri input",
    );
  }
}

function validatePortableDataOnly(
  declaration: TakoformDeclaredInterface & { readonly document: JsonObject },
): void {
  try {
    assertTakoformPortableDataOnly(declaration.document, "$.document");
    if (declaration.documentSchema) {
      assertTakoformPortableDataOnly(
        declaration.documentSchema,
        "$.documentSchema",
      );
    }
    for (const input of declaration.inputs ?? []) {
      if (
        input.source === "literal" &&
        Object.prototype.hasOwnProperty.call(input, "value")
      ) {
        assertTakoformPortableDataOnly(
          input.value as never,
          `$.inputs.${input.name}.value`,
        );
      }
    }
  } catch (error) {
    throw new InterfaceServiceError(
      "invalid_argument",
      error instanceof Error
        ? error.message
        : "Interface declaration violates portable data policy",
    );
  }
}

async function writableResource(
  options: PortableDeclarationWriterOptions,
  input: {
    readonly actor: ActorContext;
    readonly space: string;
    readonly kind: string;
    readonly name: string;
  },
): Promise<{
  readonly resource: ResourceObject;
  readonly resourceId: string;
  readonly workspaceId: string;
}> {
  const resource = await options.getResource(
    input.space,
    input.kind,
    input.name,
  );
  if (
    !resource ||
    resource.status?.phase !== "Ready" ||
    resource.status.observedGeneration !== resource.metadata.generation
  ) {
    throw new InterfaceServiceError(
      "failed_precondition",
      "exposing Resource is not Ready",
    );
  }
  const resourceId = formatResourceShapeId(
    resource.metadata.space,
    resource.kind,
    resource.metadata.name,
  );
  const workspaceId = await options.resolveWorkspace({
    resourceSpaceId: resource.metadata.space,
    resourceId,
  });
  if (
    !workspaceId ||
    (input.actor.workspaceId !== undefined &&
      input.actor.workspaceId !== workspaceId)
  ) {
    throw new InterfaceServiceError(
      "not_found",
      "exposing Resource was not found",
    );
  }
  return { resource, resourceId, workspaceId };
}

function validatePortablePointers(descriptor: FormInterfaceDescriptor): void {
  for (const input of descriptor.inputs ?? []) {
    if (
      input.pointer !== undefined &&
      input.pointer !== "" &&
      (!input.pointer.startsWith("/") || /~(?:[^01]|$)/u.test(input.pointer))
    ) {
      throw new InterfaceServiceError(
        "invalid_argument",
        `Interface input ${input.name} has an invalid RFC 6901 pointer`,
      );
    }
  }
}

function isPortableIacIdentity(
  iface: Interface,
  name: string,
  version: string,
): boolean {
  const source = iface.metadata.materializedFrom;
  return (
    source?.source === "portable_iac" &&
    source.descriptorName === name &&
    source.descriptorVersion === version
  );
}

async function portableIacRecordName(
  name: string,
  version: string,
): Promise<string> {
  const digest = await sha256HexAsync(
    new TextEncoder().encode(`${name}\0${version}`),
  );
  return `iac.${name.slice(0, 96)}.${digest.slice(0, 24)}`;
}

function sameInterfaceSpec(left: InterfaceSpec, right: InterfaceSpec): boolean {
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

function portableInputsOf(
  iface: Interface,
): NonNullable<TakoformDeclaredInterface["inputs"]> {
  return Object.entries(iface.spec.inputs ?? {}).map(([name, input]) => {
    if (iface.spec.access.resourceUriInput === name) {
      return { name, source: "resource_uri" };
    }
    if (input.source === "literal") {
      return { name, source: "literal", value: input.value };
    }
    if (input.source === "resource_output") {
      const outputName =
        input.outputName === undefined
          ? ""
          : `/${encodePointerToken(input.outputName)}`;
      return {
        name,
        source: "output",
        pointer: `${outputName}${input.pointer ?? ""}`,
      };
    }
    // portable_iac never creates capsule_output. Returning a host-namespaced
    // source keeps an unexpected retained record explicit rather than lying.
    return {
      name,
      source: "takosumi.capsule_output",
      pointer: `/${encodePointerToken(input.outputName)}${input.pointer ?? ""}`,
    };
  });
}

function encodePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}
