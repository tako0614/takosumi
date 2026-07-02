import {
  appendTakosumiAppHandoff,
  createTakosumiAppConnectHref,
  createTakosumiAppHandoffUrl,
  takosumiAppHandoffFromSearch,
  takosumiAppProductLabel,
  type TakosumiAppHandoff,
} from "takosumi-contract";

export { createTakosumiAppHandoffUrl };

export type { TakosumiAppHandoff as AppHandoff } from "takosumi-contract";

export function appHandoffFromSearch(
  search: string,
): TakosumiAppHandoff | undefined {
  return takosumiAppHandoffFromSearch(search);
}

export function appendAppHandoff(
  path: string | undefined,
  handoff: TakosumiAppHandoff | undefined,
): string | undefined {
  return appendTakosumiAppHandoff(path, handoff);
}

export function createAppHandoffConnectHref(
  handoff: TakosumiAppHandoff | undefined,
  hostUrl: string | undefined,
): string | undefined {
  if (!handoff || !hostUrl) return undefined;
  return createTakosumiAppConnectHref({ handoff, hostUrl });
}

export function appHandoffProductLabel(product: string): string {
  return takosumiAppProductLabel(product);
}
