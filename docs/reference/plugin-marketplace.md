# Plugin Marketplace and Remote Install

> Stability: removed / not current Audience: operator / kernel-implementer See
> also: [Provider Plugins](/reference/providers),
> [WAL Stages](/reference/wal-stages),
> [Environment Variables](/reference/env-vars)

This page is kept only to close a historical design branch. Current Takosumi
kernel contract does **not** include a plugin marketplace, remote plugin install
path, executable hook package, or catalog-supplied WAL hook runtime.

## Current Contract

- User manifests never install executable code.
- The kernel does not fetch marketplace indexes or remote package modules.
- The kernel does not run `pre-commit` / `post-commit` hook packages from a
  marketplace.
- Operator-selected ProviderPlugin implementations are supplied out-of-band by
  the operator's deployment packaging and selected by explicit kernel
  configuration.
- Workflow / build / Git / hook-like repository automation belongs to
  `takosumi-git` or another upstream product that calls the kernel deploy API
  with a compiled Shape manifest.

In other words, `ProviderPlugin` is a kernel extension point, but **marketplace
install of plugin code is not a kernel feature**.

## Rejected Vocabulary

Do not add the following as active docs, APIs, CLI surfaces, manifest fields, or
environment variables:

- `takosumi.plugin-marketplace.v1`
- `takosumi plugin marketplace fetch`
- `takosumi plugin install --marketplace ...`
- `TAKOSUMI_KERNEL_PLUGIN_MARKETPLACE_URLS`
- `TAKOSUMI_KERNEL_PLUGIN_MARKETPLACE_PACKAGES`
- removed `executable-hook-package`
- marketplace-installed `pre-commit` / `post-commit` hook packages

Historical references may appear only when they are clearly labeled as removed,
rejected, or future RFC material.

## Why Removed

Remote marketplace install would make the kernel responsible for supply-chain
discovery, publisher trust policy, remote module import, and hook execution.
That breaks the current layer model: the kernel is a manifest deploy engine and
compute substrate. Installer UX, repository workflow, catalog trust, and
operator release promotion are substitutable products around the kernel API, not
kernel responsibilities.
