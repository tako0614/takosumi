/**
 * Official template registry.
 *
 * The catalog is authored as TypeScript data (see `opentofu-modules/README.md`) and
 * imported statically here. The registry validates every entry once at module
 * load (fail fast on a malformed catalog object) and indexes by `id@version`.
 *
 * The deploy-control domain resolves a template by id+version, validates request
 * inputs against it, runs rootgen, and threads the template/build/generatedRoot
 * onto the runner dispatch payload. Templates are never projected into the
 * public ledger beyond the recorded id/version binding and the allowlisted
 * public outputs.
 */

import type { TemplateDefinition } from "takosumi-contract/deploy-control-api";
import { awsS3StorageTemplate } from "../../../../opentofu-modules/aws-s3-storage/template.ts";
import { cloudflareR2StorageTemplate } from "../../../../opentofu-modules/cloudflare-r2-storage/template.ts";
import { cloudflareStaticSiteTemplate } from "../../../../opentofu-modules/cloudflare-static-site/template.ts";
import { cloudflareWorkerServiceTemplate } from "../../../../opentofu-modules/cloudflare-worker-service/template.ts";
import { coreTemplate } from "../../../../opentofu-modules/core/template.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import { assertValidTemplate } from "./validation.ts";

/** Source-of-truth catalog list. Add new templates here. */
const CATALOG: readonly TemplateDefinition[] = [
  coreTemplate,
  cloudflareR2StorageTemplate,
  cloudflareWorkerServiceTemplate,
  cloudflareStaticSiteTemplate,
  awsS3StorageTemplate,
];

function registryKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function buildRegistry(
  catalog: readonly TemplateDefinition[],
): ReadonlyMap<string, TemplateDefinition> {
  const map = new Map<string, TemplateDefinition>();
  for (const template of catalog) {
    assertValidTemplate(template);
    const key = registryKey(template.id, template.version);
    if (map.has(key)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `duplicate template in catalog: ${key}`,
      );
    }
    map.set(key, template);
  }
  return map;
}

const REGISTRY = buildRegistry(CATALOG);

export class TemplateRegistry {
  readonly #byKey: ReadonlyMap<string, TemplateDefinition>;

  constructor(
    catalog: readonly TemplateDefinition[] = CATALOG,
    prebuilt?: ReadonlyMap<string, TemplateDefinition>,
  ) {
    this.#byKey = prebuilt ?? buildRegistry(catalog);
  }

  list(): readonly TemplateDefinition[] {
    return Array.from(this.#byKey.values());
  }

  get(id: string, version: string): TemplateDefinition | undefined {
    return this.#byKey.get(registryKey(id, version));
  }

  /**
   * Resolves a template, throwing `not_found` when the id+version is unknown.
   * Both id and version are required; there is no implicit "latest" so a stored
   * PlanRun binding always resolves to the exact reviewed template.
   */
  require(id: string, version: string): TemplateDefinition {
    const template = this.get(id, version);
    if (!template) {
      throw new OpenTofuControllerError(
        "not_found",
        `template ${registryKey(id, version)} is not in the official catalog`,
      );
    }
    return template;
  }
}

/** Shared default registry over the built-in catalog. */
export const defaultTemplateRegistry = new TemplateRegistry(CATALOG, REGISTRY);
