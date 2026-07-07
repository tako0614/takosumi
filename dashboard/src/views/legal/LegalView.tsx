import { A, useParams, type RouteSectionProps } from "@solidjs/router";
import { createEffect, createMemo, For, type JSX } from "solid-js";
import LogoMark from "../account/components/brand/LogoMark.tsx";
import {
  locale,
  setDocumentTitle,
  setLocale,
  type Locale,
} from "../../i18n/index.ts";
import { dashboardProductName } from "../../lib/deployment-brand.ts";

type PageKey =
  | "terms-of-service"
  | "privacy-policy"
  | "refund-policy"
  | "cancellation-policy"
  | "support";

interface Section {
  readonly title: string;
  readonly body: readonly string[];
}

interface PageCopy {
  readonly title: string;
  readonly eyebrow: string;
  readonly lead: string;
  readonly updated: string;
  readonly sections: readonly Section[];
}

const MERCHANT_NAME = "冨山翔太";
const MERCHANT_ADDRESS = "大阪府大阪市生野区巽東3-11-26";
const SUPPORT_EMAIL = "shoutatomiyama0614@gmail.com";
const SUPPORT_PHONE = "080-9545-2283";
const STATEMENT_DESCRIPTOR = "TAKOSUMI";

const ORDER: readonly PageKey[] = [
  "terms-of-service",
  "privacy-policy",
  "refund-policy",
  "cancellation-policy",
  "support",
];

const LABELS: Record<Locale, Record<PageKey, string>> = {
  ja: {
    "terms-of-service": "利用規約",
    "privacy-policy": "プライバシー",
    "refund-policy": "返金",
    "cancellation-policy": "キャンセル",
    support: "サポート",
  },
  en: {
    "terms-of-service": "Terms",
    "privacy-policy": "Privacy",
    "refund-policy": "Refunds",
    "cancellation-policy": "Cancellation",
    support: "Support",
  },
};

const COPY: Record<Locale, Record<PageKey, PageCopy>> = {
  ja: {
    "terms-of-service": {
      title: "Takosumi Cloud 利用規約",
      eyebrow: "Cloud service terms",
      lead: "Takosumi Cloud は、公式にホストされた Takosumi for Operator です。Git と OpenTofu を使ったデプロイ、公式 managed targets、使用量、上限、請求機能を提供します。",
      updated: "最終更新: 2026-07-03",
      sections: [
        {
          title: "サービスの内容",
          body: [
            "Takosumi Cloud はデジタルサービスです。物理商品の発送、配送、返品はありません。",
            "利用できる機能は、ワークスペース、プラン、利用上限、利用可能な managed resources、対象地域、運用状態によって変わることがあります。",
            "OpenTofu run、Cloud リソース、Compatibility API、AI Gateway、Object Storage、Database、Queue などの利用は、表示された使用量、上限、支払い状態に基づいて管理されます。",
          ],
        },
        {
          title: "支払いと使用量",
          body: [
            "購入前に、金額、通貨、内容、更新条件を checkout または billing 画面で確認できます。",
            "Takosumi Cloud のプランや使用量はデジタルサービスの利用権であり、現金、預金、電子マネー、引き出し可能な資産ではありません。",
            `カード明細には原則として ${STATEMENT_DESCRIPTOR} と表示されます。`,
          ],
        },
        {
          title: "利用停止と制限",
          body: [
            "支払い状態や利用上限により、有料の managed resource 実行、Compatibility API、AI Gateway、追加デプロイは実行前に停止されることがあります。",
            "不正利用、過剰な負荷、規約違反、支払い失敗、セキュリティリスクがある場合、アクセスや実行を制限することがあります。",
            "破壊的な削除や外部 provider の状態変更は、ユーザーが内容を確認してから実行する必要があります。",
          ],
        },
        {
          title: "事業者情報",
          body: [
            `運営者: ${MERCHANT_NAME}`,
            `所在地: ${MERCHANT_ADDRESS}`,
            `サポートメール: ${SUPPORT_EMAIL}`,
            `サポート電話番号: ${SUPPORT_PHONE}`,
            `カード明細には原則として ${STATEMENT_DESCRIPTOR} と表示されます。`,
          ],
        },
        {
          title: "問い合わせ",
          body: [
            `サポート連絡先は ${SUPPORT_EMAIL} です。`,
            "メールには API key、provider token、秘密鍵、password、seed phrase などの secret を送らないでください。",
          ],
        },
      ],
    },
    "privacy-policy": {
      title: "Takosumi Cloud プライバシーポリシー",
      eyebrow: "Privacy",
      lead: "Takosumi Cloud のアカウント、ワークスペース、デプロイ、請求、サポートに必要な情報の扱いを説明します。",
      updated: "最終更新: 2026-07-03",
      sections: [
        {
          title: "取得する情報",
          body: [
            "アカウント情報、ログインセッション、ワークスペース、プロジェクト、Capsule、Source、ProviderConnection、Run、StateVersion、Output、AuditEvent などのメタデータを扱います。",
            "Git URL、ref、module path、plan/apply の履歴、使用量、quota、billing event、dashboard 操作ログを扱います。",
            "Secret 値は書き込み専用として扱い、ログや公開レスポンスに表示しないように設計します。",
          ],
        },
        {
          title: "支払い処理",
          body: [
            "決済処理には Stripe を利用します。Takosumi Cloud は Stripe customer、checkout、subscription、invoice、receipt、payment status、billing event の ID や状態を保存することがあります。",
            "カード番号や CVC などの生のカード情報は Takosumi Cloud のアプリ DB には保存しません。",
          ],
        },
        {
          title: "利用目的",
          body: [
            "サービス提供、認証、デプロイ実行、state/output 管理、請求、使用量計測、サポート、セキュリティ、濫用防止、監査のために利用します。",
            "法令対応、障害調査、返金審査、支払い確認、運用改善のために必要な範囲で利用します。",
          ],
        },
        {
          title: "問い合わせ",
          body: [
            `プライバシーやデータの問い合わせは ${SUPPORT_EMAIL} へ連絡してください。`,
            "調査に必要な場合は、登録メールアドレス、workspace、run、invoice、receipt の ID を添えてください。secret は送らないでください。",
          ],
        },
      ],
    },
    "refund-policy": {
      title: "返金ポリシー",
      eyebrow: "Refund policy",
      lead: "Takosumi Cloud はデジタルサービスです。完了した managed resource usage や開始済みのサービス期間は原則として返金対象外ですが、明確な請求エラーなどは確認します。",
      updated: "最終更新: 2026-07-03",
      sections: [
        {
          title: "返金対象になり得るケース",
          body: [
            "重複請求、明確な請求エラー、購入後にサービス障害で利用できなかった場合、法令上必要な場合は確認します。",
            "返金ではなく、請求調整や service credit 付与で対応する場合があります。",
          ],
        },
        {
          title: "通常返金対象外のもの",
          body: [
            "完了した実行、開始済みのサービス期間、ユーザー操作による provider usage、外部 provider 側の費用は通常返金対象外です。",
            "物理商品の返品、配送、交換はありません。",
          ],
        },
        {
          title: "申請方法",
          body: [
            `できるだけ購入から 14 日以内に ${SUPPORT_EMAIL} へ連絡してください。`,
            "登録メールアドレス、請求日、金額、Stripe receipt または invoice ID、理由を記載してください。",
            `カード明細には原則として ${STATEMENT_DESCRIPTOR} と表示されます。`,
          ],
        },
      ],
    },
    "cancellation-policy": {
      title: "キャンセルポリシー",
      eyebrow: "Cancellation policy",
      lead: "月額プランや有料機能はいつでも停止できます。停止後は次回更新が止まり、支払い状態や利用上限により有料実行が実行前に止まります。",
      updated: "最終更新: 2026-07-03",
      sections: [
        {
          title: "月額プラン",
          body: [
            "月額プランをキャンセルすると、次回以降の更新が停止します。",
            "キャンセル時点で開始済みの期間は、返金ポリシーで認められる場合を除き、原則として返金されません。",
            "期間終了までは一部機能を利用できる場合があります。終了後は有料の追加実行や managed resource が制限されます。",
          ],
        },
        {
          title: "使用量と有料リソース",
          body: [
            "支払い状態や利用上限により、有料の managed resource、Compatibility API、AI Gateway、追加デプロイは実行前に止まります。",
            "可能な範囲で、エクスポート、削除、destroy、ログ確認、請求確認などの安全な後処理は残せるようにします。",
          ],
        },
        {
          title: "停止前の確認",
          body: [
            "停止前に、workspace、project、capsule、state、output、log、Object Storage、Database、外部 provider 側のリソースを確認してください。",
            `不明点がある場合は ${SUPPORT_EMAIL} へ連絡してください。`,
          ],
        },
      ],
    },
    support: {
      title: "Takosumi Cloud サポート",
      eyebrow: "Support",
      lead: "アカウント、ログイン、請求、デプロイ、Cloud リソース、使用量の問い合わせを受け付けます。",
      updated: "連絡先",
      sections: [
        {
          title: "事業者情報",
          body: [
            `運営者: ${MERCHANT_NAME}`,
            `所在地: ${MERCHANT_ADDRESS}`,
            `サポートメール: ${SUPPORT_EMAIL}`,
            `サポート電話番号: ${SUPPORT_PHONE}`,
          ],
        },
        {
          title: SUPPORT_EMAIL,
          body: [
            "問い合わせには、登録メールアドレス、workspace、project、capsule、run、resource、請求や receipt の ID、発生時刻、期待した動作を含めてください。",
            "API key、provider token、秘密鍵、password、seed phrase、service account JSON などの secret は送らないでください。",
            "返金、キャンセル、請求確認の問い合わせもこの連絡先で受け付けます。",
          ],
        },
      ],
    },
  },
  en: {
    "terms-of-service": {
      title: "Takosumi Cloud Terms of Service",
      eyebrow: "Cloud service terms",
      lead: "Takosumi Cloud is the official hosted Takosumi for Operator. It provides Git and OpenTofu deploys, official managed targets, usage, limits, and billing features.",
      updated: "Last updated: 2026-07-03",
      sections: [
        {
          title: "Service",
          body: [
            "Takosumi Cloud is a digital service. There is no physical shipping, delivery, return, or exchange.",
            "Available features depend on the workspace, plan, usage limits, managed resources, region, and operational status.",
            "OpenTofu runs, Cloud resources, Compatibility APIs, AI Gateway, Object Storage, Database, Queue, and related features are managed through visible usage, limits, and payment state.",
          ],
        },
        {
          title: "Payment and usage",
          body: [
            "Before checkout, the amount, currency, contents, and renewal terms are shown in Checkout or the billing screen.",
            "Takosumi Cloud plans and usage are digital service access, not cash, a deposit, electronic money, or a withdrawable asset.",
            `Card statements generally show ${STATEMENT_DESCRIPTOR}.`,
          ],
        },
        {
          title: "Suspension and limits",
          body: [
            "Paid managed resource execution, Compatibility APIs, AI Gateway calls, and additional deploys may stop before they run when payment state or usage limits require it.",
            "Access or execution may be limited for abuse, excessive load, policy violations, failed payment, or security risk.",
            "Destructive deletion and external provider changes require the user to review what will run.",
          ],
        },
        {
          title: "Merchant information",
          body: [
            `Operator: ${MERCHANT_NAME}`,
            `Address: ${MERCHANT_ADDRESS}`,
            `Support email: ${SUPPORT_EMAIL}`,
            `Support phone: ${SUPPORT_PHONE}`,
            `Card statements generally show ${STATEMENT_DESCRIPTOR}.`,
          ],
        },
        {
          title: "Contact",
          body: [
            `Support is available at ${SUPPORT_EMAIL}.`,
            "Do not send API keys, provider tokens, private keys, passwords, seed phrases, or other secrets by email.",
          ],
        },
      ],
    },
    "privacy-policy": {
      title: "Takosumi Cloud Privacy Policy",
      eyebrow: "Privacy",
      lead: "This page explains how Takosumi Cloud handles information needed for accounts, workspaces, deploys, billing, and support.",
      updated: "Last updated: 2026-07-03",
      sections: [
        {
          title: "Information we process",
          body: [
            "We process metadata for accounts, login sessions, workspaces, projects, Capsules, Sources, ProviderConnections, Runs, StateVersions, Outputs, and AuditEvents.",
            "We process Git URLs, refs, module paths, plan/apply history, usage, quota, billing events, and dashboard operation logs.",
            "Secret values are treated as write-only material and are designed not to appear in logs or public responses.",
          ],
        },
        {
          title: "Payment processing",
          body: [
            "Payments are processed by Stripe. Takosumi Cloud may store Stripe customer, checkout, subscription, invoice, receipt, payment status, and billing event IDs and state.",
            "Raw card numbers and CVC values are not stored in the Takosumi Cloud application database.",
          ],
        },
        {
          title: "Purpose",
          body: [
            "We use this information to provide the service, authenticate users, run deploys, manage state and outputs, bill, meter usage, provide support, secure the service, prevent abuse, and keep audit records.",
            "We may also use it for legal compliance, incident investigation, refund review, payment confirmation, and operational improvement.",
          ],
        },
        {
          title: "Contact",
          body: [
            `For privacy or data questions, contact ${SUPPORT_EMAIL}.`,
            "If an investigation is needed, include your registered email address and relevant workspace, run, invoice, or receipt IDs. Do not send secrets.",
          ],
        },
      ],
    },
    "refund-policy": {
      title: "Refund Policy",
      eyebrow: "Refund policy",
      lead: "Takosumi Cloud is a digital service. Completed managed resource usage and started service periods are generally not refundable, but clear billing errors and similar cases can be reviewed.",
      updated: "Last updated: 2026-07-03",
      sections: [
        {
          title: "Cases we may review",
          body: [
            "We may review duplicate charges, clear billing errors, service outages that prevented use shortly after purchase, and cases where a refund is legally required.",
            "A billing adjustment or service credit may be offered instead of a payment refund.",
          ],
        },
        {
          title: "Generally not refundable",
          body: [
            "Completed executions, started service periods, provider usage caused by user actions, and external provider costs are generally not refundable.",
            "There are no physical returns, delivery refunds, or exchanges.",
          ],
        },
        {
          title: "How to request review",
          body: [
            `Contact ${SUPPORT_EMAIL}, preferably within 14 days of purchase.`,
            "Include your registered email address, charge date, amount, Stripe receipt or invoice ID, and the reason for the request.",
            `Card statements generally show ${STATEMENT_DESCRIPTOR}.`,
          ],
        },
      ],
    },
    "cancellation-policy": {
      title: "Cancellation Policy",
      eyebrow: "Cancellation policy",
      lead: "Paid plans and features can be stopped at any time. Cancellation stops future renewals, and payment state or usage limits can stop paid execution before it runs.",
      updated: "Last updated: 2026-07-03",
      sections: [
        {
          title: "Monthly plans",
          body: [
            "Canceling a monthly plan stops future renewals.",
            "A service period that has already started is generally not refundable except as described in the refund policy.",
            "Some features may remain available until the end of the current period. After that, paid additional execution and managed resources are limited.",
          ],
        },
        {
          title: "Usage and paid resources",
          body: [
            "Payment state or usage limits can stop paid managed resources, Compatibility APIs, AI Gateway calls, and additional deploys before execution.",
            "Safe follow-up actions such as export, deletion, destroy, log review, and billing review should remain available where possible.",
          ],
        },
        {
          title: "Before canceling",
          body: [
            "Review your workspaces, projects, Capsules, state, outputs, logs, Object Storage, Databases, and external provider resources before stopping service.",
            `For questions, contact ${SUPPORT_EMAIL}.`,
          ],
        },
      ],
    },
    support: {
      title: "Takosumi Cloud Support",
      eyebrow: "Support",
      lead: "Support covers accounts, login, billing, deploys, Cloud resources, and usage questions.",
      updated: "Contact",
      sections: [
        {
          title: "Merchant information",
          body: [
            `Operator: ${MERCHANT_NAME}`,
            `Address: ${MERCHANT_ADDRESS}`,
            `Support email: ${SUPPORT_EMAIL}`,
            `Support phone: ${SUPPORT_PHONE}`,
          ],
        },
        {
          title: SUPPORT_EMAIL,
          body: [
            "Include your registered email address, workspace, project, Capsule, run, resource, billing or receipt ID, the time of the issue, and what you expected to happen.",
            "Do not send API keys, provider tokens, private keys, passwords, seed phrases, service account JSON, or other secrets.",
            "Refund, cancellation, and billing review requests can also be sent here.",
          ],
        },
      ],
    },
  },
};

interface Props extends Partial<RouteSectionProps<unknown>> {
  readonly page?: PageKey;
}

export default function LegalView(props: Props) {
  const params = useParams<{ page?: string }>();
  const pageKey = createMemo<PageKey>(() => {
    const requested = props.page ?? params.page;
    return ORDER.includes(requested as PageKey)
      ? (requested as PageKey)
      : "terms-of-service";
  });
  const copy = createMemo(() => COPY[locale()][pageKey()]);

  createEffect(() => setDocumentTitle(copy().title));

  return (
    <main class="legal-page">
      <section class="legal-card" aria-labelledby="legal-title">
        <header class="legal-header">
          <A class="legal-brand" href="/">
            <LogoMark size={40} title={dashboardProductName()} />
            <span>{dashboardProductName()}</span>
          </A>
          <div class="legal-actions">
            <div class="legal-lang" role="group" aria-label="Language">
              <button
                type="button"
                classList={{ active: locale() === "ja" }}
                onClick={() => setLocale("ja")}
              >
                JA
              </button>
              <button
                type="button"
                classList={{ active: locale() === "en" }}
                onClick={() => setLocale("en")}
              >
                EN
              </button>
            </div>
            <A class="legal-sign-in" href="/sign-in">
              Sign in
            </A>
          </div>
        </header>

        <nav class="legal-nav" aria-label="Takosumi Cloud policies">
          <For each={ORDER}>
            {(key) => (
              <A
                class="legal-nav-link"
                classList={{ active: pageKey() === key }}
                href={key === "support" ? "/support" : `/legal/${key}`}
              >
                {LABELS[locale()][key]}
              </A>
            )}
          </For>
        </nav>

        <article class="legal-content">
          <p class="legal-kicker">{copy().eyebrow}</p>
          <h1 id="legal-title">{copy().title}</h1>
          <p class="legal-lead">{copy().lead}</p>
          <p class="legal-updated">{copy().updated}</p>
          <For each={copy().sections}>
            {(section) => (
              <section class="legal-section">
                <h2>{section.title}</h2>
                <For each={section.body}>
                  {(paragraph) => <p>{renderPolicyText(paragraph)}</p>}
                </For>
              </section>
            )}
          </For>
        </article>
      </section>
    </main>
  );
}

function renderPolicyText(text: string): JSX.Element {
  if (!text.includes(SUPPORT_EMAIL)) return text;
  const parts = text.split(SUPPORT_EMAIL);
  return (
    <>
      {parts[0]}
      <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      {parts[1]}
    </>
  );
}
