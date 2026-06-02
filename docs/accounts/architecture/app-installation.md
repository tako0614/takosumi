# Installation Ledger

This page moved to the language-specific docs.

- [日本語](../ja/architecture/app-installation.md)
- [English](../en/architecture/app-installation.md)

## Quick Reference

AppInstallation status uses the canonical 5 public statuses: `installing`,
`ready`, `failed`, `suspended`, and `exported`. Runtime materialization and
export are operation phases, not extra public statuses.

Takosumi Installer API exposes the canonical 4 public statuses for Takosumi
`Installation.status`: `installing`, `ready`, `failed`, and `suspended`.
Takosumi account-plane projection statuses are separate Cloud-owned
metadata and events.

Shared-cell runtime target IDs use the format `shared-cell://<cell>/namespaces/<installation>`.
