/**
 * Generic Provider Connection form projection.
 *
 * The dashboard owns no provider catalog. Every guided option is projected
 * from the CredentialRecipe records returned by the service. Presentation
 * metadata can improve labels and link to setup documentation, but execution
 * remains exclusively defined by each recipe's env/files/preRun contract.
 */
import type {
  CredentialRecipe,
  CredentialRecipePresentationText,
} from "takosumi-contract";

export interface ProviderCredentialField {
  readonly envName: string;
  readonly label: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly placeholder?: string;
}

export interface ProviderConnectionSetupOption {
  /** Stable form option id. It has no provider admission semantics. */
  readonly id: string;
  /** Exact source declared by the service-installed recipe. */
  readonly providerSource: string;
  readonly providerAliases: readonly string[];
  readonly credentialRecipe: {
    readonly id: string;
    readonly authMode: string;
    readonly secretPartition: string;
  };
  readonly label: string;
  readonly description?: string;
  readonly fields: readonly ProviderCredentialField[];
  readonly setupGuide?: {
    readonly url: string;
    readonly steps: readonly string[];
  };
}

/** Localize service-owned presentation text without interpreting its meaning. */
export function credentialRecipePresentationText(
  value: CredentialRecipePresentationText | undefined,
  locale: string,
): string | undefined {
  if (typeof value === "string") return nonEmpty(value);
  if (!value) return undefined;
  const language = locale.toLowerCase().split("-")[0];
  return (
    nonEmpty(value[locale]) ??
    (language ? nonEmpty(value[language]) : undefined) ??
    nonEmpty(value.en) ??
    Object.values(value).map(nonEmpty).find(Boolean)
  );
}

/**
 * Builds connection forms solely from service-installed CredentialRecipes.
 * Modes must explicitly opt in to setup presentation; absence from this list
 * never blocks API/CLI execution and is not a provider allowlist.
 */
export function providerSetupOptionsFromCredentialRecipes(
  recipes: readonly CredentialRecipe[],
  locale: string,
): readonly ProviderConnectionSetupOption[] {
  return recipes.flatMap((recipe) => {
    if (
      recipe.terraformSource === "*" ||
      recipe.terraformSource.length === 0 ||
      !nonEmpty(recipe.secretPartition)
    ) {
      return [];
    }
    const providerSource = nonEmpty(recipe.terraformSource[0]);
    if (!providerSource) return [];
    const providerAliases = recipe.terraformSource
      .slice(1)
      .map(nonEmpty)
      .filter((source): source is string => source !== undefined);

    return Object.entries(recipe.authModes).flatMap(
      ([authMode, definition]) => {
        const presentation = definition.presentation;
        if (presentation?.showInConnectionSetup !== true) return [];

        const fields = Object.entries(definition.env ?? {}).flatMap(
          ([envName, material]) => {
            const hint = definition.inputHints?.[envName];
            if (
              envName === "*" ||
              hint?.hidden === true ||
              material.from === "generated" ||
              material.from === "literal" ||
              material.from === "user_defined"
            ) {
              return [];
            }
            const label =
              credentialRecipePresentationText(hint?.label, locale) ??
              readableToken(material.name ?? envName);
            const placeholder = credentialRecipePresentationText(
              hint?.placeholder,
              locale,
            );
            return [
              {
                envName,
                label,
                required: hint?.required ?? true,
                // A service hint may make a non-secret value private in the
                // form, but it can never render declared secret material clear.
                secret: material.from === "secret" || hint?.secret === true,
                ...(placeholder ? { placeholder } : {}),
              },
            ];
          },
        );
        if (fields.length === 0) return [];

        const authModeLabel =
          credentialRecipePresentationText(presentation.displayName, locale) ??
          readableToken(authMode);
        const description = credentialRecipePresentationText(
          presentation.description,
          locale,
        );
        const setupGuide = presentation.setupGuide;
        const setupGuideUrl = safeHttpsUrl(setupGuide?.url);
        const steps = (setupGuide?.steps ?? []).flatMap((step) => {
          const text = credentialRecipePresentationText(step, locale);
          return text ? [text] : [];
        });

        return [
          {
            id: `recipe:${recipe.id}:${authMode}`,
            providerSource,
            providerAliases,
            credentialRecipe: {
              id: recipe.id,
              authMode,
              secretPartition: recipe.secretPartition!,
            },
            label: `${recipe.displayName} — ${authModeLabel}`,
            ...(description ? { description } : {}),
            fields,
            ...(setupGuideUrl
              ? {
                  setupGuide: {
                    url: setupGuideUrl,
                    steps,
                  },
                }
              : {}),
          },
        ];
      },
    );
  });
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function readableToken(value: string): string {
  const normalized = value.trim().replaceAll(/[_-]+/gu, " ");
  if (!normalized) return value;
  return normalized.replace(/\b\p{Ll}/gu, (letter) => letter.toUpperCase());
}

function safeHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
