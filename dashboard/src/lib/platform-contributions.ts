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

export async function loadPlatformContributions(): Promise<PlatformContributionCatalog> {
  const response = await fetch(PLATFORM_CONTRIBUTIONS_PATH, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Platform contributions failed (${response.status})`);
  }
  const value = (await response.json()) as PlatformContributionCatalog;
  if (
    value.kind !== "takosumi.platform-extension-contributions@v1" ||
    !Array.isArray(value.contributions)
  ) {
    throw new Error("Platform contributions response is invalid");
  }
  return value;
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
