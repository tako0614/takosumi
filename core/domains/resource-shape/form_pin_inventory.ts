/**
 * Fail-closed, operator-only inventory for the exact Service Form pin cutover.
 *
 * The receipt intentionally projects only identity and pin fields. It does not
 * expose Resource specs, Outputs, NativeResource details, target selection, or
 * other customer values. A complete capture scans every durable Workspace and
 * every bundled compatibility kind twice; a concurrent semantic change makes
 * the operation fail instead of returning a partial/self-asserted manifest.
 */

import {
  isBundledResourceShapeKind,
  RESOURCE_SHAPE_KINDS,
  type BundledResourceShapeKind,
  type InstalledFormReference,
} from "takosumi-contract";
import type { Page, PageParams } from "takosumi-contract/pagination";
import type { Workspace } from "takosumi-contract/workspaces";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import type { ResourceShapeRecord } from "./records.ts";
import type { ResourceShapeStore } from "./stores.ts";

export const RESOURCE_FORM_PIN_INVENTORY_KIND =
  "takosumi.resource-form-pin-inventory@v1" as const;

export interface ResourceFormPinInventoryBounds {
  readonly pageSize: number;
  readonly maxWorkspaces: number;
  readonly maxScannedResources: number;
  readonly maxResources: number;
}

export interface ResourceFormPinInventoryKindCounts {
  readonly resources: number;
  readonly pinned: number;
  readonly unpinned: number;
}

export interface ResourceFormPinInventoryMatrixEntry extends ResourceFormPinInventoryKindCounts {
  readonly workspaceId: string;
  readonly space: string;
  readonly kind: BundledResourceShapeKind;
}

export interface ResourceFormPinInventoryRow {
  readonly workspaceId: string;
  readonly space: string;
  readonly resourceId: string;
  readonly name: string;
  readonly kind: BundledResourceShapeKind;
  readonly form: InstalledFormReference | null;
}

export interface ResourceFormPinInventoryReceipt {
  readonly kind: typeof RESOURCE_FORM_PIN_INVENTORY_KIND;
  readonly complete: true;
  readonly capturedAt: string;
  readonly bounds: ResourceFormPinInventoryBounds;
  readonly counts: {
    readonly workspaces: number;
    readonly scopes: number;
    readonly resources: number;
    readonly pinned: number;
    readonly unpinned: number;
    readonly byKind: Readonly<
      Record<BundledResourceShapeKind, ResourceFormPinInventoryKindCounts>
    >;
  };
  /** Includes every Workspace x bundled-kind scope, including zero rows. */
  readonly matrix: readonly ResourceFormPinInventoryMatrixEntry[];
  readonly rows: readonly ResourceFormPinInventoryRow[];
  /** Digest of the canonical matrix + rows, independent of capture time. */
  readonly matrixDigest: string;
}

export interface ResourceFormPinInventoryReader {
  capture(): Promise<ResourceFormPinInventoryReceipt>;
}

export interface ResourceFormPinInventoryDependencies {
  readonly workspaces: {
    listWorkspacesPage(params: PageParams): Promise<Page<Workspace>>;
  };
  readonly resources: Pick<ResourceShapeStore, "listByKindsPage">;
  readonly resolveSpace: (
    workspaceId: string,
  ) => string | undefined | Promise<string | undefined>;
  readonly now?: () => string;
  readonly bounds?: Partial<ResourceFormPinInventoryBounds>;
}

const DEFAULT_BOUNDS: ResourceFormPinInventoryBounds = {
  pageSize: 100,
  maxWorkspaces: 4_096,
  maxScannedResources: 20_000,
  maxResources: 10_000,
};

interface SemanticSnapshot {
  readonly matrix: readonly ResourceFormPinInventoryMatrixEntry[];
  readonly rows: readonly ResourceFormPinInventoryRow[];
  readonly matrixDigest: string;
}

export class ResourceFormPinInventoryService implements ResourceFormPinInventoryReader {
  readonly #dependencies: ResourceFormPinInventoryDependencies;
  readonly #bounds: ResourceFormPinInventoryBounds;

  constructor(dependencies: ResourceFormPinInventoryDependencies) {
    this.#dependencies = dependencies;
    this.#bounds = parseBounds(dependencies.bounds);
  }

  async capture(): Promise<ResourceFormPinInventoryReceipt> {
    const first = await this.#captureSemanticSnapshot();
    const second = await this.#captureSemanticSnapshot();
    if (first.matrixDigest !== second.matrixDigest) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "Resource Form pin inventory changed during capture; retry from a stable ledger",
        { reason: "resource_form_pin_inventory_changed" },
      );
    }

    const byKind = emptyKindCounts();
    let pinned = 0;
    for (const row of second.rows) {
      const counts = byKind[row.kind];
      counts.resources += 1;
      if (row.form) {
        counts.pinned += 1;
        pinned += 1;
      } else {
        counts.unpinned += 1;
      }
    }
    const workspaces = new Set(second.matrix.map((entry) => entry.workspaceId));
    return {
      kind: RESOURCE_FORM_PIN_INVENTORY_KIND,
      complete: true,
      capturedAt: this.#dependencies.now?.() ?? new Date().toISOString(),
      bounds: this.#bounds,
      counts: {
        workspaces: workspaces.size,
        scopes: second.matrix.length,
        resources: second.rows.length,
        pinned,
        unpinned: second.rows.length - pinned,
        byKind,
      },
      matrix: second.matrix,
      rows: second.rows,
      matrixDigest: second.matrixDigest,
    };
  }

  async #captureSemanticSnapshot(): Promise<SemanticSnapshot> {
    const workspaces = await readAllPages(
      (params) => this.#dependencies.workspaces.listWorkspacesPage(params),
      this.#bounds.pageSize,
      this.#bounds.maxWorkspaces,
      "Workspace",
    );
    ensureUnique(workspaces, (workspace) => workspace.id, "Workspace id");

    const scopes = await mapWithConcurrency(
      workspaces,
      16,
      async (workspace) => {
        const resolved = await this.#dependencies.resolveSpace(workspace.id);
        if (!resolved || resolved.trim() === "") {
          throw new OpenTofuControllerError(
            "failed_precondition",
            `Workspace ${workspace.id} has no authorized Resource Space mapping`,
            {
              reason: "resource_form_pin_inventory_scope_missing",
              workspaceId: workspace.id,
            },
          );
        }
        return { workspaceId: workspace.id, space: resolved.trim() };
      },
    );
    ensureUnique(scopes, (scope) => scope.space, "Resource Space mapping");
    const sortedScopes = [...scopes].sort((a, b) =>
      a.workspaceId.localeCompare(b.workspaceId),
    );
    const workspaceBySpace = new Map(
      sortedScopes.map((scope) => [scope.space, scope.workspaceId] as const),
    );

    const scannedResources = await readAllPages(
      (params) =>
        this.#dependencies.resources.listByKindsPage(
          RESOURCE_SHAPE_KINDS,
          params,
        ),
      this.#bounds.pageSize,
      this.#bounds.maxScannedResources,
      "Resource",
    );
    ensureUnique(scannedResources, (resource) => resource.id, "Resource id");

    const rows = scannedResources
      .flatMap((resource) => {
        const workspaceId = workspaceBySpace.get(resource.spaceId);
        return workspaceId ? [projectResourceRow(workspaceId, resource)] : [];
      })
      .sort(compareRows);
    if (rows.length > this.#bounds.maxResources) {
      throw exhausted("authorized Resources", this.#bounds.maxResources);
    }

    const matrixByKey = new Map<string, ResourceFormPinInventoryMatrixEntry>();
    for (const scope of sortedScopes) {
      for (const kind of RESOURCE_SHAPE_KINDS) {
        matrixByKey.set(matrixKey(scope.workspaceId, kind), {
          ...scope,
          kind,
          resources: 0,
          pinned: 0,
          unpinned: 0,
        });
      }
    }
    for (const row of rows) {
      const key = matrixKey(row.workspaceId, row.kind);
      const current = matrixByKey.get(key);
      if (!current) {
        throw new OpenTofuControllerError(
          "internal_error",
          "Resource Form pin inventory encountered an unauthorized scope",
        );
      }
      matrixByKey.set(key, {
        ...current,
        resources: current.resources + 1,
        pinned: current.pinned + (row.form ? 1 : 0),
        unpinned: current.unpinned + (row.form ? 0 : 1),
      });
    }
    const matrix = [...matrixByKey.values()];
    return {
      matrix,
      rows,
      matrixDigest: await stableJsonDigest({
        kind: RESOURCE_FORM_PIN_INVENTORY_KIND,
        matrix,
        rows,
      }),
    };
  }
}

async function readAllPages<T>(
  readPage: (params: PageParams) => Promise<Page<T>>,
  pageSize: number,
  maximum: number,
  label: string,
): Promise<readonly T[]> {
  const items: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    if (cursor) {
      if (cursors.has(cursor)) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `${label} inventory cursor repeated before completion`,
          { reason: "resource_form_pin_inventory_cursor_cycle" },
        );
      }
      cursors.add(cursor);
    }
    const page = await readPage({
      limit: pageSize,
      ...(cursor ? { cursor } : {}),
    });
    if (page.items.length > pageSize) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `${label} inventory page exceeded its requested bound`,
        { reason: "resource_form_pin_inventory_page_overflow" },
      );
    }
    if (page.items.length === 0 && page.nextCursor) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `${label} inventory returned an empty non-terminal page`,
        { reason: "resource_form_pin_inventory_empty_page" },
      );
    }
    if (items.length + page.items.length > maximum) {
      throw exhausted(`${label} inventory`, maximum);
    }
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

function projectResourceRow(
  workspaceId: string,
  resource: ResourceShapeRecord,
): ResourceFormPinInventoryRow {
  if (!isBundledResourceShapeKind(resource.kind)) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "Resource inventory store returned a kind outside the requested set",
      { reason: "resource_form_pin_inventory_kind_mismatch" },
    );
  }
  return {
    workspaceId,
    space: resource.spaceId,
    resourceId: resource.id,
    name: resource.name,
    kind: resource.kind,
    form: resource.form ? projectForm(resource.form) : null,
  };
}

function projectForm(form: InstalledFormReference): InstalledFormReference {
  return {
    formRef: {
      apiVersion: form.formRef.apiVersion,
      kind: form.formRef.kind,
      definitionVersion: form.formRef.definitionVersion,
      schemaDigest: form.formRef.schemaDigest,
    },
    packageDigest: form.packageDigest,
  };
}

function compareRows(
  a: ResourceFormPinInventoryRow,
  b: ResourceFormPinInventoryRow,
): number {
  return (
    a.workspaceId.localeCompare(b.workspaceId) ||
    RESOURCE_SHAPE_KINDS.indexOf(a.kind) -
      RESOURCE_SHAPE_KINDS.indexOf(b.kind) ||
    a.name.localeCompare(b.name) ||
    a.resourceId.localeCompare(b.resourceId)
  );
}

function emptyKindCounts(): Record<
  BundledResourceShapeKind,
  { resources: number; pinned: number; unpinned: number }
> {
  return Object.fromEntries(
    RESOURCE_SHAPE_KINDS.map((kind) => [
      kind,
      { resources: 0, pinned: 0, unpinned: 0 },
    ]),
  ) as Record<
    BundledResourceShapeKind,
    { resources: number; pinned: number; unpinned: number }
  >;
}

function ensureUnique<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string,
): void {
  const keys = new Set<string>();
  for (const value of values) {
    const key = keyOf(value);
    if (keys.has(key)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `${label} ${key} appeared more than once in the inventory`,
        { reason: "resource_form_pin_inventory_duplicate" },
      );
    }
    keys.add(key);
  }
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<readonly U[]> {
  const result = new Array<U>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        result[index] = await mapper(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return result;
}

function matrixKey(
  workspaceId: string,
  kind: BundledResourceShapeKind,
): string {
  return `${workspaceId}\u0000${kind}`;
}

function parseBounds(
  override: Partial<ResourceFormPinInventoryBounds> | undefined,
): ResourceFormPinInventoryBounds {
  const parsed = { ...DEFAULT_BOUNDS, ...override };
  for (const [name, value] of Object.entries(parsed)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (parsed.pageSize > 100) {
    throw new TypeError("pageSize must not exceed the store page limit of 100");
  }
  return parsed;
}

function exhausted(label: string, maximum: number): OpenTofuControllerError {
  return new OpenTofuControllerError(
    "resource_exhausted",
    `${label} exceeds the complete-capture limit of ${maximum}`,
    { reason: "resource_form_pin_inventory_limit" },
  );
}
