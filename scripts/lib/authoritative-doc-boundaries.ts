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
  ],
  "docs/en/index.md": [
    {
      pattern:
        /Takosumi does not ship a first-party Terraform\/OpenTofu provider/u,
      message:
        "English index must state that Takosumi ships no first-party provider",
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
        /Takosumi ships no first-party Terraform\/OpenTofu provider/u,
      message: "Final Plan must keep provider implementation external",
    },
  ],
  "docs/internal/core-spec.md": [
    {
      pattern:
        /Takosumi ships no first-party Terraform\/OpenTofu provider/u,
      message: "Core Spec must keep provider implementation external",
    },
  ],
  "docs/internal/core-conformance.md": [
    {
      pattern:
        /No first-party provider source, release, custody, or public mirror lane exists/u,
      message:
        "Core conformance must prove all first-party provider lanes absent",
    },
  ],
};

const CLOUD_GA_SERVICE_FORMS = [
  "EdgeWorker",
  "ObjectBucket",
  "KVStore",
  "SQLDatabase",
  "Queue",
  "VectorIndex",
  "DurableWorkflow",
  "ContainerService",
  "StatefulActorNamespace",
  "Schedule",
] as const;

const CLOUD_GA_PUBLIC_SERVICES = [
  "Edge Worker",
  "Object Storage",
  "KV",
  "Database",
  "Queue",
  "Vector Index",
  "Durable Workflow",
  "Container",
  "Stateful Actor Namespace",
  "Schedule",
  "AI Gateway",
  "Verified custom domain",
] as const;

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

  const finalPlan = byPath.get("docs/internal/final-plan.md");
  if (finalPlan?.content.includes("## 11.")) {
    const publicOffering = section(finalPlan.content, "## 11.", "## 12.");
    const gaContract = section(finalPlan.content, "## 14.", "## 15.");
    const split =
      /\n(?:Stable|Preview):\s|seven\s+service forms|seven\s+Stable/iu.exec(
        publicOffering,
      );
    if (split) {
      violations.push({
        ruleId: "cloud-ga-split-contract",
        path: finalPlan.path,
        line: lineAt(finalPlan.content, finalPlan.content.indexOf(split[0])),
        message:
          "Final Plan section 11 must not split the all-or-nothing Cloud GA set into Stable and Preview subsets",
        excerpt: split[0].trim(),
      });
    }
    if (
      !/all-or-nothing/iu.test(publicOffering) ||
      !/Pre-GA/u.test(publicOffering)
    ) {
      violations.push({
        ruleId: "cloud-ga-missing-all-or-nothing",
        path: finalPlan.path,
        line: lineAt(finalPlan.content, finalPlan.content.indexOf("## 11.")),
        message:
          "Final Plan section 11 must name the single all-or-nothing Pre-GA contract",
        excerpt: "## 11. Takosumi Cloud Public Offering",
      });
    }
    for (const service of [
      ...CLOUD_GA_SERVICE_FORMS,
      "AI Gateway",
      "VerifiedDomain",
    ]) {
      if (publicOffering.includes(service) && gaContract.includes(service))
        continue;
      violations.push({
        ruleId: "cloud-ga-service-set-drift",
        path: finalPlan.path,
        line: lineAt(finalPlan.content, finalPlan.content.indexOf("## 11.")),
        message: `Final Plan sections 11 and 14 must both include ${service}`,
        excerpt: service,
      });
    }
  }

  for (const path of ["app-docs/index.md", "app-docs/en/index.md"]) {
    const source = byPath.get(path);
    if (!source) continue;
    for (const service of CLOUD_GA_PUBLIC_SERVICES) {
      if (source.content.toLowerCase().includes(service.toLowerCase()))
        continue;
      violations.push({
        ruleId: "cloud-docs-ga-service-omitted",
        path,
        line: 1,
        message: `hosted Cloud availability matrix must include ${service}`,
        excerpt: service,
      });
    }
    const staleStatus =
      /seven\s+Stable|7\s*つの Stable|eight offerings|\|\s*(?:Stable|Preview)\s*\|/iu.exec(
        source.content,
      );
    if (staleStatus) {
      violations.push({
        ruleId: "cloud-docs-ga-split-contract",
        path,
        line: lineAt(source.content, source.content.indexOf(staleStatus[0])),
        message:
          "hosted Cloud docs must keep the complete GA set Pre-GA instead of publishing Stable/Preview subsets",
        excerpt: staleStatus[0].trim(),
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

function section(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  if (startIndex < 0) return "";
  const endIndex = content.indexOf(end, startIndex + start.length);
  return content.slice(startIndex, endIndex < 0 ? content.length : endIndex);
}
