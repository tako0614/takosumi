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

const REQUIRED_DOC_CLAIMS: Readonly<
  Record<
    string,
    readonly { readonly pattern: RegExp; readonly message: string }[]
  >
> = {
  "docs/index.md": [
    {
      pattern:
        /Takosumi は first-party Terraform\/OpenTofu provider を同梱しません/u,
      message:
        "Japanese index must state that Takosumi ships no first-party provider",
    },
    {
      pattern:
        /BYOC[\s\S]{0,500}ProviderConnection[\s\S]{0,500}customer-owned resource/iu,
      message:
        "Japanese index must keep the customer-owned BYOC provider path authoritative",
    },
    {
      pattern:
        /Generic Offering[\s\S]{0,240}(?:conformance gap|migration|legacy\/operator-only)/iu,
      message:
        "Japanese index must mark Generic Offering as a non-Core conformance gap",
    },
    {
      pattern:
        /Takosumi Cloud[\s\S]{0,140}(?:退役|retired|historical)/iu,
      message:
        "Japanese index must identify Takosumi Cloud as a retired historical identity",
    },
    {
      pattern:
        /Takoserver[\s\S]{0,500}(?:WfP|Workers[- ]for[- ]Platforms)[\s\S]{0,180}(?:managed Offering|Offering)/iu,
      message:
        "Japanese index must keep managed supply and WfP authority with Takoserver",
    },
  ],
  "docs/en/index.md": [
    {
      pattern:
        /Takosumi does not ship a first-party Terraform\/OpenTofu provider/u,
      message:
        "English index must state that Takosumi ships no first-party provider",
    },
    {
      pattern:
        /BYOC[\s\S]{0,500}ProviderConnection[\s\S]{0,500}customer-owned resource/iu,
      message:
        "English index must keep the customer-owned BYOC provider path authoritative",
    },
    {
      pattern:
        /Generic Offering[\s\S]{0,240}(?:conformance gap|migration|legacy\/operator-only)/iu,
      message:
        "English index must mark Generic Offering as a non-Core conformance gap",
    },
    {
      pattern:
        /Takosumi Cloud[\s\S]{0,140}(?:retired|historical)/iu,
      message:
        "English index must identify Takosumi Cloud as a retired historical identity",
    },
    {
      pattern:
        /Takoserver[\s\S]{0,500}(?:WfP|Workers[- ]for[- ]Platforms)[\s\S]{0,180}(?:managed Offering|Offering)/iu,
      message:
        "English index must keep managed supply and WfP authority with Takoserver",
    },
  ],
  "docs/en/concepts/boundaries.md": [
    {
      pattern:
        /(?:Provider-side objects do not\s+necessarily enter Takosumi's Resource ledger|does not mirror provider-side objects into a second Resource ledger|second lifecycle for them)/iu,
      message:
        "English product boundary must distinguish direct providers from the Resource ledger",
    },
    {
      pattern:
        /Takosumi Hosted[\s\S]{0,220}(?:retail|commerce|client composition)/iu,
      message:
        "English product boundary must limit Takosumi Hosted to retail/client composition",
    },
    {
      pattern:
        /Takoserver[\s\S]{0,500}(?:managed supply|managed-service Offering|capacity)[\s\S]{0,500}(?:WfP|Workers[- ]for[- ]Platforms)/iu,
      message:
        "English product boundary must keep managed supply and WfP authority with Takoserver",
    },
    {
      pattern:
        /Takosumi Cloud[\s\S]{0,140}retired historical identity/iu,
      message:
        "English product boundary must identify Takosumi Cloud as historical",
    },
  ],
  "docs/concepts/boundaries.md": [
    {
      pattern:
        /(?:provider 側の resource は必ずしも\s+Takosumi の Resource 台帳には入りません|別の Takosumi Resource ledger に複製して、第二の lifecycle を作りません)/u,
      message:
        "Japanese product boundary must distinguish direct providers from the Resource ledger",
    },
    {
      pattern:
        /Takosumi Hosted[\s\S]{0,220}(?:retail|commerce|client composition)/iu,
      message:
        "Japanese product boundary must limit Takosumi Hosted to retail/client composition",
    },
    {
      pattern:
        /Takoserver[\s\S]{0,500}(?:managed supply|managed-service Offering|capacity)[\s\S]{0,500}(?:WfP|Workers[- ]for[- ]Platforms)/iu,
      message:
        "Japanese product boundary must keep managed supply and WfP authority with Takoserver",
    },
    {
      pattern:
        /Takosumi Cloud[\s\S]{0,140}(?:退役|retired)[\s\S]{0,80}historical identity/iu,
      message:
        "Japanese product boundary must identify Takosumi Cloud as historical",
    },
  ],
  "docs/concepts/interfaces.md": [
    {
      pattern:
        /provider credential、account id、native resource id、bearer token は\s+渡しません/u,
      message:
        "Japanese Interface docs must keep managed runtime provider authority private",
    },
  ],
  "docs/en/concepts/interfaces.md": [
    {
      pattern:
        /does not receive provider credentials, account ids, native resource ids, or bearer\s+tokens/u,
      message:
        "English Interface docs must keep managed runtime provider authority private",
    },
  ],
  "docs/reference/repository-manifest.md": [
    {
      pattern:
        /将来 metadata\s+section を追加するときは新しい `apiVersion` を定義し、未知 field は\s+安全側に停止/u,
      message:
        "Japanese Repository manifest docs must keep versioned closed extensibility",
    },
  ],
  "docs/en/reference/repository-manifest.md": [
    {
      pattern:
        /A future metadata\s+section requires a new `apiVersion`; unknown fields continue to fail closed/u,
      message:
        "English Repository manifest docs must keep versioned closed extensibility",
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
        /Takosumi ships no first-party Terraform\/OpenTofu\s+provider/u,
      message: "Final Plan must keep provider implementation external",
    },
  ],
  "docs/internal/core-spec.md": [
    {
      pattern:
        /Takosumi ships no first-party Terraform\/OpenTofu\s+provider/u,
      message: "Core Spec must keep provider implementation external",
    },
    {
      pattern: /Takosumi OSS is the customer BYOC control plane/iu,
      message: "Core Spec must make customer BYOC the current authority",
    },
    {
      pattern:
        /ProviderConnection\s*(?:→|->)\s*CredentialRecipe\s*(?:→|->)\s*ProviderBinding\s*(?:→|->)\s*run-scoped\s+materialization/iu,
      message: "Core Spec must define the complete run-scoped provider path",
    },
    {
      pattern: /Generic Offering is not a Takosumi Core authority/iu,
      message: "Core Spec must exclude Generic Offering from Core authority",
    },
    {
      pattern:
        /Existing source code may\s+still contain[\s\S]{0,220}implementation conformance gap/iu,
      message:
        "Core Spec must call retained Offering implementation an explicit conformance gap",
    },
    {
      pattern:
        /Resource Shape[\s\S]{0,180}(?:migration internals|migration-only|not a supported OSS authoring)/iu,
      message:
        "Core Spec must keep Resource/Form Host lifecycle migration-only",
    },
    {
      pattern:
        /Takosumi Cloud[\s\S]{0,140}retired historical identity/iu,
      message: "Core Spec must identify Takosumi Cloud as historical",
    },
    {
      pattern:
        /managed customer `ModuleWorker`[\s\S]{0,180}(?:Workers\s+for\s+Platforms|WfP)[\s\S]{0,180}Takoserver/iu,
      message:
        "Core Spec must keep managed customer Worker runtime with Takoserver",
    },
  ],
  "docs/internal/core-conformance.md": [
    {
      pattern:
        /Takosumi has no parent Host credential,[\s\S]{0,220}(?:provider installation|backend|capacity|WfP namespace|native identity)/iu,
      message:
        "Core conformance must keep provider installation and managed Host authority external",
    },
    {
      pattern:
        /Customer BYOC[\s\S]{0,280}ProviderConnection[\s\S]{0,220}run-scoped materialization/iu,
      message:
        "Core conformance must record the customer-owned BYOC provider path",
    },
    {
      pattern:
        /Generic Offering[\s\S]{0,320}(?:conformance gap|no Offering catalog)/iu,
      message:
        "Core conformance must record Generic Offering as a conformance gap",
    },
    {
      pattern:
        /Resource\/Form lifecycle[\s\S]{0,260}migration-only/iu,
      message:
        "Core conformance must record Resource/Form lifecycle as migration-only",
    },
    {
      pattern:
        /Deploy boundary[\s\S]{0,300}managed customer `ModuleWorker`[\s\S]{0,300}Takoserver/iu,
      message:
        "Core conformance must keep managed customer Worker deploy with Takoserver",
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

  for (const source of sources) {
    if (!source.path.startsWith("app-docs/") || !source.path.endsWith(".md")) {
      continue;
    }
    // App docs are retained as historical material. The notice is deliberately
    // checked near the top so a footer or an unlinked archive page cannot make
    // an old Cloud availability/pricing/SLA claim look current.
    const notice = source.content.slice(0, 1_200);
    const archiveMarker =
      /Historical archive|歴史資料（アーカイブ）/iu.test(notice) &&
      /not current authority|現行の正本ではありません/iu.test(notice);
    if (!archiveMarker) {
      violations.push({
        ruleId: "app-docs-archive-notice-missing",
        path: source.path,
        line: 1,
        message:
          "app docs must begin with a prominent historical-archive notice",
        excerpt: "Historical archive — not current authority",
      });
    }
    if (
      !/(?:退役した[\s>]*|retired[\s>]+)Takosumi Cloud|Takosumi Cloud[\s\S]{0,300}(?:retired|退役|historical|歴史)/iu.test(
        notice,
      )
    ) {
      violations.push({
        ruleId: "app-docs-retired-cloud-claim-missing",
        path: source.path,
        line: 1,
        message:
          "app docs must identify Takosumi Cloud as a retired historical identity",
        excerpt: "Takosumi Cloud ... retired historical identity",
      });
    }
    if (
      !/(?:not current (?:availability|pricing|SLA|support|production)|(?:availability|pricing|SLA|support)[\s\S]{0,180}(?:not current authority|current authority ではありません|示しません)|現行サービスの根拠に使わない)/iu.test(
        notice,
      )
    ) {
      violations.push({
        ruleId: "app-docs-current-cloud-authority-claim",
        path: source.path,
        line: 1,
        message:
          "app docs must deny current Cloud availability, pricing, SLA, and support authority",
        excerpt: "not current availability/pricing/SLA/support authority",
      });
    }
    if (
      !/Takosumi Hosted[\s\S]{0,320}(?:retail|commerce|client)/iu.test(
        notice,
      )
    ) {
      violations.push({
        ruleId: "app-docs-hosted-ownership-claim-missing",
        path: source.path,
        line: 1,
        message:
          "app docs must send current retail/commerce/client authority to Takosumi Hosted",
        excerpt: "Takosumi Hosted ... retail ... commerce ... client",
      });
    }
    // Japanese archive notices put the ownership subject after the list of
    // managed surfaces (for example, "managed supply ... を Takoserver が
    // 所有します"). Accept either word order, but keep the terms close so
    // unrelated mentions cannot satisfy the ownership claim.
    if (
      !/Takoserver[\s\S]{0,360}(?:managed supply|capacity|provider credential|Offerings?)|(?:managed supply|capacity|provider credential|Offerings?)[\s\S]{0,360}Takoserver/iu.test(
        notice,
      )
    ) {
      violations.push({
        ruleId: "app-docs-takoserver-ownership-claim-missing",
        path: source.path,
        line: 1,
        message:
          "app docs must send managed supply authority to Takoserver",
        excerpt: "Takoserver ... managed supply ... capacity ... Offering",
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
