export interface AuthoritativeDocSource {
  readonly path: string;
  readonly content: string;
}

export interface AuthoritativeDocViolation {
  readonly ruleId: string;
  readonly path: string;
  readonly line: number;
  readonly message: string;
  readonly excerpt: string;
}

const RETIRED_CLOUDFLARE_COMPATIBILITY: readonly {
  readonly ruleId: string;
  readonly pattern: RegExp;
  readonly message: string;
}[] = [
  {
    ruleId: "retired-cloudflare-route",
    pattern: /\/compat\/cloudflare(?:\/|\b)/giu,
    message: "the retired Cloudflare compatibility route must not return",
  },
  {
    ruleId: "retired-cloudflare-capability",
    pattern: /compat\.cloudflare(?:\.|\b)/giu,
    message: "the retired Cloudflare compatibility capability must not return",
  },
  {
    ruleId: "retired-cloudflare-provider-pin",
    pattern: /\b5\.19\.1\b/gu,
    message:
      "the former Cloudflare provider pin is runtime history, not an authoritative docs or GA requirement",
  },
];

const TAKOSUMI_PROVIDER_TOKEN = String.raw`(?:takosumi\/takosumi|takosumi_\*|terraform-provider-takosumi|Takosumi(?:-owned)? provider|Takosumi-provider)`;
const TAKOSUMI_PROVIDER_REFERENCE = new RegExp(TAKOSUMI_PROVIDER_TOKEN, "u");
const TAKOSUMI_PROVIDER_CUSTODY_CONTEXT =
  /(?:\b(?:discontinued|retired)\b|\b(?:historical|migration|rollback|existing-state)[^.]{0,120}\bcustody\b|\bcustody\b[^.]{0,120}\b(?:historical|migration|rollback|existing-state)\b|\bno (?:corrected or replacement|corrected|replacement) Takosumi provider version\b[^.]{0,120}\b(?:built|published)\b|\bno new Takosumi-provider state is authored\b|廃止(?:済み)?|(?:historical|migration|rollback|履歴|既存 state)[^。]{0,120}\bcustody\b|\bcustody\b[^。]{0,120}(?:historical|migration|rollback|履歴|既存 state))/iu;
const TAKOSUMI_PROVIDER_ACTIVE_CLAIMS: readonly RegExp[] = [
  new RegExp(
    `${TAKOSUMI_PROVIDER_TOKEN}[^.!?]{0,160}\\b(?:will|shall|should|must|may|can|plans? to|is going to|continues? to)\\s+(?:publish|release|add|create|author|ship|update|republish|support|maintain)\\b`,
    "iu",
  ),
  new RegExp(
    `${TAKOSUMI_PROVIDER_TOKEN}[^.!?]{0,120}\\b(?:publishes|releases|adds|creates|authors|ships|updates|republishes|supports|maintains)\\b`,
    "iu",
  ),
  new RegExp(
    `${TAKOSUMI_PROVIDER_TOKEN}[^.!?]{0,80}\\bis\\s+(?:active|current|maintained|published|supported)\\b`,
    "iu",
  ),
  new RegExp(
    `(?:^|\\n)\\s*(?:Add|Create|Publish|Release|Ship|Update|Republish)\\b(?!\\s+(?:no|neither)\\b)[^.!?]{0,160}${TAKOSUMI_PROVIDER_TOKEN}`,
    "u",
  ),
  new RegExp(
    `${TAKOSUMI_PROVIDER_TOKEN}[^。]{0,120}(?:新規|今後)[^。]{0,60}(?:公開|追加|作成|更新|再公開|リリース|提供|使用|利用)(?:する|します|していく)`,
    "iu",
  ),
];

const REQUIRED_DOC_CLAIMS: Readonly<
  Record<
    string,
    readonly { readonly pattern: RegExp; readonly message: string }[]
  >
> = {
  "docs/index.md": [
    {
      pattern: /`takosumi\/takosumi` provider は廃止済み/u,
      message:
        "Japanese index must state that the Takosumi provider is discontinued",
    },
  ],
  "docs/en/index.md": [
    {
      pattern: /`takosumi\/takosumi` provider is discontinued/u,
      message:
        "English index must state that the Takosumi provider is discontinued",
    },
  ],
  "docs/reference/api.md": [
    {
      pattern:
        /Cloudflare 固有の import\/deploy compatibility profile は廃止済み/u,
      message:
        "Japanese API reference must keep the Cloudflare profile retired",
    },
  ],
  "docs/en/reference/api.md": [
    {
      pattern:
        /Cloudflare-specific import\/deploy compatibility profile is retired/u,
      message: "English API reference must keep the Cloudflare profile retired",
    },
  ],
  "docs/internal/final-plan.md": [
    {
      pattern:
        /No corrected or replacement Takosumi provider version will\s+be built or published/u,
      message: "Final Plan must forbid a replacement Takosumi provider release",
    },
  ],
  "docs/internal/core-spec.md": [
    {
      pattern: /No new Takosumi-provider state is authored/u,
      message: "Core Spec must keep new Takosumi provider state retired",
    },
  ],
  "docs/internal/core-conformance.md": [
    {
      pattern: /No provider release or default mirror lane exists/u,
      message:
        "Core conformance must keep provider release and mirror lanes absent",
    },
  ],
};

export function findAuthoritativeDocViolations(
  sources: readonly AuthoritativeDocSource[],
): AuthoritativeDocViolation[] {
  const violations: AuthoritativeDocViolation[] = [];
  const byPath = new Map(sources.map((source) => [source.path, source]));

  for (const source of sources) {
    for (const rule of RETIRED_CLOUDFLARE_COMPATIBILITY) {
      for (const match of source.content.matchAll(rule.pattern)) {
        const index = match.index ?? 0;
        violations.push({
          ruleId: rule.ruleId,
          path: source.path,
          line: lineAt(source.content, index),
          message: rule.message,
          excerpt: lineExcerpt(source.content, index),
        });
      }
    }

    for (const paragraph of paragraphs(source.content)) {
      if (!TAKOSUMI_PROVIDER_REFERENCE.test(paragraph.content)) continue;
      const activeClaim = TAKOSUMI_PROVIDER_ACTIVE_CLAIMS.some((pattern) =>
        pattern.test(paragraph.content),
      );
      if (
        !activeClaim &&
        TAKOSUMI_PROVIDER_CUSTODY_CONTEXT.test(paragraph.content)
      ) {
        continue;
      }
      violations.push({
        ruleId: "active-takosumi-provider-doc",
        path: source.path,
        line: paragraph.line,
        message: activeClaim
          ? "active Takosumi provider publication or resource-authoring claims are forbidden even beside retirement wording"
          : "Takosumi provider references must be explicitly limited to discontinued historical migration/rollback custody",
        excerpt: paragraph.content.split("\n", 1)[0]?.trim() ?? "",
      });
    }
  }

  for (const [path, claims] of Object.entries(REQUIRED_DOC_CLAIMS)) {
    const source = byPath.get(path);
    if (!source) {
      violations.push({
        ruleId: "missing-authoritative-doc",
        path,
        line: 1,
        message: "required authoritative document is missing from the scan",
        excerpt: path,
      });
      continue;
    }
    for (const claim of claims) {
      if (claim.pattern.test(source.content)) continue;
      violations.push({
        ruleId: "missing-retirement-claim",
        path,
        line: 1,
        message: claim.message,
        excerpt: claim.pattern.source,
      });
    }
  }

  return violations;
}

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function lineExcerpt(content: string, index: number): string {
  const start = content.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const end = content.indexOf("\n", index);
  return content.slice(start, end < 0 ? content.length : end).trim();
}

function paragraphs(
  content: string,
): readonly { readonly content: string; readonly line: number }[] {
  const result: { content: string; line: number }[] = [];
  let offset = 0;
  for (const paragraph of content.split(/\n[ \t]*\n/gu)) {
    const index = content.indexOf(paragraph, offset);
    result.push({ content: paragraph, line: lineAt(content, index) });
    offset = index + paragraph.length;
  }
  return result;
}
