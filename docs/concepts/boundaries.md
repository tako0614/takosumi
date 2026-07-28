# 製品の境界

Takosumi という名前は 3 つの層で使われます。このページが境界を説明する唯一の
ページです。ほかのページでは繰り返しません。

| 層 | 何か |
| --- | --- |
| Takosumi software | AGPL-3.0 のソフトウェア。誰でも自分の環境で動かせる |
| Takosumi for Operator | それを他人向けに運用するための枠組み |
| Takosumi Cloud | 私たちが運用している公式の hosted サービス |

## Takosumi software が持つもの

- Git を正とする OpenTofu control plane
- Capsule と Run の lifecycle、状態と監査の台帳
- 任意で有効にできる Resource (Service Form host)
- 互換 API の枠組みと Adapter の仕組み
- Interface と InterfaceBinding
- CLI、dashboard、accounts

このドキュメントが説明するのはこの層です。**どの endpoint でも成り立つ挙動**だけを
書いています。

## 運用主体が持つもの

同じソフトウェアでも、次は運用する主体が決めます。

- どの Resource の種類を有効にするか
- 配置先 (TargetPool) と、そこで使える実装
- 課金を記録するか、請求するか
- 定期観測の頻度と並列数
- production への deploy と secret の運用手順

したがって「Takosumi で X ができるか」の答えは endpoint によって変わります。
確認する方法は 1 つで、その endpoint に聞きます。

```bash
curl -s https://takosumi.example.com/.well-known/takosumi
```

`features` に何が有効かが入っています。edition の名前ではなく、この capability を
見てください。

## Takosumi Cloud が持つもの

公式の hosted サービスにだけあるものです。

- 公式の managed な配置先と、その内部実装
- 請求を伴う課金
- support と SLA
- 公開価格、無料枠、残高不足時の挙動

**これらはソフトウェアの機能ではありません。** 料金や managed リソースの使い方は
Cloud 側のドキュメントにあります。

## self-host との関係

software を自分で動かす権利と、公式サービスを使う権利は別です。self-host した
endpoint は、上の「運用主体が持つもの」を自分で決めます。その endpoint の利用者に
とっては、あなたが operator です。

## 関連

- [全体像](./index.md)
- [用語集](../reference/glossary.md)
