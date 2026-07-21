export const PLATFORM_CONTRIBUTIONS_PATH =
  "/__takosumi/platform/contributions" as const;

export interface PlatformContribution {
  readonly id: string;
  readonly slot: string;
  readonly href: `/${string}`;
  readonly label: string;
  readonly description?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly descriptions?: Readonly<Record<string, string>>;
  readonly order?: number;
}

export interface PlatformContributionCatalog {
  readonly kind: "takosumi.platform-extension-contributions@v1";
  readonly generatedAt: string;
  readonly contributions: readonly PlatformContribution[];
}

/**
 * Optional operator-installed navigation/legal decorations.
 *
 * This NEVER rejects. Every consumer reads it through `createResource`, and
 * reading an errored resource re-throws into the root ErrorBoundary — which
 * wraps the whole Router, including `/sign-in`. A deployment that simply does
 * not serve this endpoint (or a transient 5xx) must degrade to "no extra
 * entries", not take the entire app down to a chrome-less reload card.
 */
export async function loadPlatformContributions(): Promise<
  PlatformContributionCatalog | undefined
> {
  try {
    const response = await fetch(PLATFORM_CONTRIBUTIONS_PATH, {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;
    const value = (await response.json()) as PlatformContributionCatalog;
    if (
      value.kind !== "takosumi.platform-extension-contributions@v1" ||
      !Array.isArray(value.contributions)
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export function platformContributionsForSlot(
  catalog: PlatformContributionCatalog | undefined,
  slot: string,
): readonly PlatformContribution[] {
  return (catalog?.contributions ?? []).filter(
    (contribution) => contribution.slot === slot,
  );
}

export function platformContributionLabel(
  contribution: PlatformContribution,
  locale: string,
): string {
  return localized(contribution.labels, locale) ?? contribution.label;
}

export function platformContributionDescription(
  contribution: PlatformContribution,
  locale: string,
): string | undefined {
  return (
    localized(contribution.descriptions, locale) ?? contribution.description
  );
}

function localized(
  values: Readonly<Record<string, string>> | undefined,
  locale: string,
): string | undefined {
  const language = locale.split("-")[0];
  return values?.[locale] ?? (language ? values?.[language] : undefined);
}
