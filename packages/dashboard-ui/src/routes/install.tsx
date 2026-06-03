import { Title } from "@solidjs/meta";
import AuthGuard from "~/components/auth/AuthGuard";
import InstallWizard from "~/components/apps/InstallWizard";

/**
 * Canonical install-by-URL entry for Takosumi.
 *
 * This is the official, advertised way to install any OpenTofu-module repo:
 * open
 *   https://accounts.takosumi.com/install?git=<repo>&ref=<ref>&mode=<mode>&autoplan=1
 * and Takosumi pre-fills the install wizard and runs the PlanRun. Product
 * landing pages (takos.jp, yurucommu.com, …) "ride on" this by linking here
 * with their own repository pre-filled — Takos is just one such repo.
 *
 * Cold visitors are routed through sign-in by AuthGuard with the full
 * `?return=/install?git=…` preserved, so the git params survive the OAuth
 * round-trip. `/apps/install` renders the same wizard for the in-dashboard
 * "+ Install" button.
 */
export default function InstallByUrl() {
  return (
    <>
      <Title>Install — Takosumi</Title>
      <AuthGuard>{() => <InstallWizard />}</AuthGuard>
    </>
  );
}
