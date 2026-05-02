import type { JsonObject } from "./types.ts";
import type { ManifestResource } from "./manifest-resource.ts";

export interface TemplateValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface Template<Inputs = JsonObject> {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  validateInputs(value: unknown, issues: TemplateValidationIssue[]): void;
  expand(inputs: Inputs): readonly ManifestResource[];
}

export function parseTemplateRef(
  ref: string,
): { readonly id: string; readonly version: string } | undefined {
  const at = ref.indexOf("@");
  if (at <= 0 || at === ref.length - 1) return undefined;
  const id = ref.slice(0, at);
  const version = ref.slice(at + 1);
  if (id.length === 0 || version.length === 0) return undefined;
  return { id, version };
}

export function formatTemplateRef(id: string, version: string): string {
  return `${id}@${version}`;
}

const TEMPLATE_REGISTRY = new Map<string, Template>();

function templateKey(id: string, version: string): string {
  return formatTemplateRef(id, version);
}

export function registerTemplate(
  template: Template,
): Template | undefined {
  const key = templateKey(template.id, template.version);
  const previous = TEMPLATE_REGISTRY.get(key);
  TEMPLATE_REGISTRY.set(key, template);
  return previous;
}

export function unregisterTemplate(id: string, version: string): boolean {
  return TEMPLATE_REGISTRY.delete(templateKey(id, version));
}

export function getTemplate(id: string, version: string): Template | undefined {
  return TEMPLATE_REGISTRY.get(templateKey(id, version));
}

export function getTemplateByRef(ref: string): Template | undefined {
  const parsed = parseTemplateRef(ref);
  if (!parsed) return undefined;
  return getTemplate(parsed.id, parsed.version);
}

export function listTemplates(): readonly Template[] {
  return Array.from(TEMPLATE_REGISTRY.values());
}

export function isTemplateRegistered(id: string, version: string): boolean {
  return TEMPLATE_REGISTRY.has(templateKey(id, version));
}
