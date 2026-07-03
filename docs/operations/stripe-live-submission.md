# Stripe live submission notes

この文書は Stripe live onboarding / approval で入力するための operator memo です。
公開ページではありません。公開 customer-facing 情報は `takosumi.com` の pricing section と
`docs/legal/*` / `docs/support.md` に置きます。

## Business / product description

```text
Takosumi Cloud is the official hosted Takosumi for Operator service.
It lets users deploy and operate Git-managed OpenTofu/Terraform services and
Takosumi managed resources from a browser, including app hosting, storage,
database, queue, and AI gateway features. Customers pay a monthly hosted plan
and purchase USD-denominated Takosumi Cloud usage credit for managed resource
usage. Takosumi OSS remains available for self-hosting without Takosumi Cloud
billing.
```

短い日本語説明:

```text
Takosumi Cloud は、Git と OpenTofu/Terraform を使ってアプリや managed resources
をデプロイ・運用する公式ホスティングサービスです。月額 plan と USD-denominated
usage credit によって、Cloud resource usage を支払います。
```

## Public URLs

```text
Website:
  https://takosumi.com/

Pricing:
  https://takosumi.com/#pricing

Application:
  https://app.takosumi.com/

Support:
  https://takosumi.com/docs/support

Terms:
  https://takosumi.com/docs/legal/terms-of-service

Privacy:
  https://takosumi.com/docs/legal/privacy-policy

Refund policy:
  https://takosumi.com/docs/legal/refund-policy

Cancellation policy:
  https://takosumi.com/docs/legal/cancellation-policy
```

## Public business information to verify in Stripe

Stripe の Public details / Checkout settings では、少なくとも次を合わせます。

```text
Statement descriptor:
  TAKOSUMI

Support email:
  support@takosumi.com

Support website:
  https://takosumi.com/docs/support

Terms of service:
  https://takosumi.com/docs/legal/terms-of-service

Privacy policy:
  https://takosumi.com/docs/legal/privacy-policy

Refund policy:
  https://takosumi.com/docs/legal/refund-policy
```

住所、電話番号、法人名、代表者情報は operator の法務・Stripe account owner が
Stripe Dashboard の Public details / Business details に入力します。repo には実値を置きません。

## Checkout policy display

Stripe Checkout / Customer Portal では、可能なら次を表示します。

- support contact information
- Terms of Service
- Privacy Policy
- Refund Policy
- cancellation terms for subscriptions

Customer-facing text should state that Takosumi Cloud is a digital service,
has no physical shipping, and usage credit is not cash or withdrawable balance.
