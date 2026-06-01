# HTTP 公開 {#http-exposure}

Takosumi v1 では HTTP 公開を Source 内の Takosumi 専用 DSL では表しません。
公開 endpoint、custom domain、TLS、route、runtime target は operator catalog が
公開する PlatformService と、その operator が選んだ runtime / gateway
implementation の責務です。

## Install 時の扱い

```text
Source
  -> Installer API dry-run
  -> operator catalog が HTTP / runtime PlatformService を解決
  -> InstallPlan に公開予定 output と binding selection を表示
  -> apply が Deployment に bindingsSnapshot / outputs を記録
```

Takosumi core が保証するのは Deployment record です。HTTP request を実際に受ける
data plane、host assignment、TLS certificate、DNS ownership proof、backend route
object は operator distribution が管理します。

## Runtime request path

```text
client
  -> operator-managed listener / route / gateway
  -> active runtime target selected by current Deployment
  <- response
```

traffic authority は Installation の current Deployment pointer です。rollback は
retained `succeeded` Deployment を current pointer に戻します。Takosumi core は
rollback 時に Source を再解決しません。

## Public output

Deployment `outputs` には、operator が公開可能と判断した non-secret endpoint
metadata だけを保存します。secret、provider object id、certificate private key、
DNS verification token は operator evidence / secret store に置きます。

## Related

- [本体仕様](./core-spec.md)
- [Installer API](./installer-api.md)
- [プラットフォームサービス](./platform-services.md)
