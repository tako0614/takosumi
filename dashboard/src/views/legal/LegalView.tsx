/**
 * Provider-neutral fallback legal surface for an operator deployment. Official
 * hosted-service terms belong to that host's `legal.*` extension contributions.
 */
import { A, useParams } from "@solidjs/router";
import { For } from "solid-js";
import { dashboardProductName } from "../../lib/runtime-capabilities.ts";
import { locale, t } from "../../i18n/index.ts";

type LegalPage =
  | "terms-of-service"
  | "privacy-policy"
  | "refund-policy"
  | "cancellation-policy"
  | "support";

interface Props {
  readonly page?: LegalPage;
}

const PAGES: readonly LegalPage[] = [
  "terms-of-service",
  "privacy-policy",
  "refund-policy",
  "cancellation-policy",
  "support",
];

const COPY = {
  ja: {
    "terms-of-service": {
      title: "利用条件",
      lead: "このページは、現在の Takosumi 運用者が提供するサービス条件の案内です。契約条件、料金、SLA、サポート範囲は運用者が公開する正本を確認してください。",
    },
    "privacy-policy": {
      title: "プライバシー",
      lead: "Takosumi はアカウント、Workspace、Run、監査に必要な情報を扱います。保存期間、外部処理者、問い合わせ先は運用者のプライバシーポリシーを確認してください。",
    },
    "refund-policy": {
      title: "返金",
      lead: "返金やクレジットの条件は、支払い機能を提供する運用者の規約と適用法令に従います。OSS Takosumi 自体は支払いを処理しません。",
    },
    "cancellation-policy": {
      title: "解約",
      lead: "有料サービスの解約、更新、データ保持は運用者が提供する管理画面と規約に従います。",
    },
    support: {
      title: "サポート",
      lead: "このデプロイの運用者が公開するサポート窓口と運用手順を利用してください。",
    },
  },
  en: {
    "terms-of-service": {
      title: "Terms",
      lead: "This is the provider-neutral fallback for the current Takosumi operator. Consult the operator's published terms for contract terms, pricing, SLA, and support scope.",
    },
    "privacy-policy": {
      title: "Privacy",
      lead: "Takosumi processes information needed for accounts, Workspaces, Runs, and audit. Consult the operator's privacy policy for retention, subprocessors, and contact details.",
    },
    "refund-policy": {
      title: "Refunds",
      lead: "Refund and credit conditions are defined by the operator that supplies payment functionality and by applicable law. OSS Takosumi does not process payments.",
    },
    "cancellation-policy": {
      title: "Cancellation",
      lead: "Cancellation, renewal, and data-retention terms for paid services are controlled by the operator's management surface and terms.",
    },
    support: {
      title: "Support",
      lead: "Use the support contact and runbooks published by the operator of this deployment.",
    },
  },
} as const;

export default function LegalView(props: Props) {
  const params = useParams();
  const page = (): LegalPage => {
    const value = props.page ?? params.page;
    return PAGES.includes(value as LegalPage)
      ? (value as LegalPage)
      : "terms-of-service";
  };
  const language = () => (locale().startsWith("ja") ? "ja" : "en");
  const copy = () => COPY[language()][page()];

  return (
    <main class="legal-page">
      <section class="legal-card" aria-labelledby="legal-title">
        <header class="legal-header">
          <A class="legal-brand" href="/">
            {dashboardProductName()}
          </A>
          <A class="legal-sign-in" href="/sign-in">
            {t("auth.signIn")}
          </A>
        </header>
        <nav class="legal-nav" aria-label={t("legal.policiesNav")}>
          <For each={PAGES}>
            {(key) => (
              <A
                class="legal-nav-link"
                classList={{ active: page() === key }}
                href={key === "support" ? "/support" : `/legal/${key}`}
              >
                {COPY[language()][key].title}
              </A>
            )}
          </For>
        </nav>
        <article class="legal-content">
          <h1 id="legal-title">{copy().title}</h1>
          <p class="legal-lead">{copy().lead}</p>
        </article>
      </section>
    </main>
  );
}
