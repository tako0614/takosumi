import type {
  ActorContext,
  Interface,
  JsonObject,
  ResourceObject,
  TakoformDeclaredInterface,
} from "takosumi-contract";
import { formRefKey } from "takosumi-contract";
import type { Page, PageParams } from "takosumi-contract/pagination";
import { formatResourceShapeId } from "../resource-shape/records.ts";
import type { InterfaceService } from "./service.ts";
import type { ResourceInterfaceWorkspaceResolver } from "./output_resolver.ts";

const RESOURCE_PAGE_LIMIT = 100;

export interface PortableDeclarationReaderOptions {
  readonly interfaces: InterfaceService;
  readonly listResources: (
    space: string,
    page: PageParams,
  ) => Promise<Page<ResourceObject>>;
  readonly resolveWorkspace: ResourceInterfaceWorkspaceResolver;
  /** Idempotent lazy repair for Ready Resources created before this feature. */
  readonly ensureResourceDeclarations?: (
    resource: ResourceObject,
  ) => Promise<void>;
}

export interface PortableDeclarationFilter {
  readonly actor: ActorContext;
  readonly space: string;
  readonly name?: string;
  readonly version?: string;
  readonly resourceKind?: string;
  readonly resourceName?: string;
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
      let cursor: string | undefined;
      do {
        const page = await options.listResources(input.space, {
          limit: RESOURCE_PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        });
        for (const resource of page.items) {
          if (
            (input.resourceKind !== undefined &&
              resource.kind !== input.resourceKind) ||
            (input.resourceName !== undefined &&
              resource.metadata.name !== input.resourceName)
          ) {
            continue;
          }
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
          const workspaceId = await options.resolveWorkspace({
            resourceSpaceId: resource.metadata.space,
            resourceId,
          });
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
          // Lazy repair is a write. Never let a scoped reader trigger it for a
          // Resource outside the already-proven Workspace bridge.
          await options.ensureResourceDeclarations?.(resource);
          const owned = await options.interfaces.list({
            workspaceId,
            ownerKind: "Resource",
            ownerId: resourceId,
            includeRetired: false,
          });
          for (const iface of owned) {
            const projected = projectDeclaration(iface, resource);
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
        cursor = page.nextCursor;
      } while (cursor);

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

function projectDeclaration(
  iface: Interface,
  resource: ResourceObject,
): TakoformDeclaredInterface | undefined {
  if (
    resource.status?.phase !== "Ready" ||
    resource.status.observedGeneration !== resource.metadata.generation
  ) {
    return undefined;
  }
  if (iface.status.phase !== "Resolved") return undefined;
  if (iface.spec.access.visibility === "private") return undefined;
  const lineage = iface.metadata.materializedFrom;
  if (lineage?.source !== "form_descriptor" || !resource.form) return undefined;
  if (
    lineage.formRefKey !== formRefKey(resource.form.formRef) ||
    lineage.formSchemaDigest !== resource.form.formRef.schemaDigest ||
    lineage.descriptorName !== iface.spec.type ||
    lineage.descriptorVersion !== iface.spec.version
  ) {
    return undefined;
  }
  const document = isJsonObject(iface.spec.document)
    ? iface.spec.document
    : undefined;
  const values = iface.status.resolvedInputs
    ? ({ ...iface.status.resolvedInputs } as JsonObject)
    : undefined;
  return {
    name: lineage.descriptorName,
    version: lineage.descriptorVersion,
    resource: { kind: resource.kind, name: resource.metadata.name },
    ...(document ? { document } : {}),
    ...(values ? { values } : {}),
    form: resource.form,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
