# Manifest Plugin Kernel Design

この設計書は概念ごとに分離した。旧 URL を残すため、このページは案内だけを
保持する。

## Read Instead

- [Design Overview](/design/) — Takosumi 全体の概念 map
- [Manifest Model](/design/manifest-model) — `Component` / `Contract` /
  `Provider` / `Bundle` / `Plugin` / `Lock`
- [Core Deployment Model](/design/core-deployment-model) — `Deployment` /
  `ProviderObservation` / `GroupHead` / `ObjectAddress`
- [Execution Lifecycle](/design/execution-lifecycle) — plan / apply / destroy /
  status / rollback / runtime-agent
- [Routing Model](/design/routing-model) — HTTP API route、manifest route、
  Deployment route、routing projection、service endpoint の分離
- [Artifacts and Supply Chain](/design/artifacts-and-supply-chain) — artifact
  store、bundled catalog、kernel plugin、manifest plugin trust
- [Operator Boundaries](/design/operator-boundaries) — auth、secret、
  self-host、credential boundary、observability

## Why Split

Takosumi の設計は manifest syntax だけでは決まらない。manifest は authoring
surface、Core Deployment は canonical state、Execution Lifecycle は operation、
Routing は traffic と service discovery、Supply Chain は artifact / plugin /
trust、Operator Boundary は self-host security を扱う。

1 本の doc に混ぜると、provider abstraction、bundle portability、route
ownership、kernel plugin trust、runtime-agent credential boundary が同じ粒度に
見えてしまう。分離後は、それぞれの抽象を独立して検証し、実装差分へ落とせる。
