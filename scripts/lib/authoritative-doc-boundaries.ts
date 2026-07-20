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

const TAKOSUMI_PROVIDER_REFERENCE =
  /(?:takosumi\/takosumi|takosumi_\*|terraform-provider-takosumi|Takosumi(?:-owned)? provider|Takosumi-provider)/u;
const TAKOSUMI_PROVIDER_CUSTODY_CONTEXT =
  /(?:discontinued|retired|historical|custody|no (?:new|corrected|replacement)|not (?:an? )?(?:active|published|updated|required|mandatory)|never required|does not revive|without reviving|does not depend|no dependency|must not be (?:overwritten|republished)|廃止|旧 provider|既存(?: compatibility)? state|履歴|新規[^。\n]*(?:使|作|公開)|更新[^。\n]*(?:しません|しない)|再公開[^。\n]*(?:しません|しない)|依存しません|不要)/iu;

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
      if (TAKOSUMI_PROVIDER_CUSTODY_CONTEXT.test(paragraph.content)) continue;
      violations.push({
        ruleId: "active-takosumi-provider-doc",
        path: source.path,
        line: paragraph.line,
        message:
          "Takosumi provider references must be explicitly limited to discontinued historical custody",
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
