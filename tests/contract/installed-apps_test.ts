import { describe, expect, test } from "bun:test";
import { installedAppSourceUrl, matchingInstalledApps, type InstalledAppSummary } from "../../contract/installed-apps.ts";

const source = { url: "https://git.example.test/team/app.git", path: "deploy/app" };
function app(id: string, overrides: Partial<InstalledAppSummary> = {}): InstalledAppSummary {
  return { capsuleId: id, name: id, state: "installed", installedFrom: source, ...overrides };
}

describe("Store installed app identity", () => {
  test("normalizes .git, trailing slash, URL fragment and relative module spelling", () => {
    expect(matchingInstalledApps([app("one")], {
      url: " https://git.example.test/team/app/#release ", path: "./deploy/app/",
    }).map((item) => item.capsuleId)).toEqual(["one"]);
  });

  test("two installs remain separate even when their revisions differ", () => {
    const first = { ...app("one"), ref: "v1.0.0" };
    const second = { ...app("two"), ref: "v2.0.0" };
    expect(matchingInstalledApps([first, second], source).map((item) => item.capsuleId)).toEqual(["one", "two"]);
  });

  test("root is equivalent to ./, but another module or repository is different", () => {
    const root = app("root", { installedFrom: { ...source, path: "." } });
    expect(matchingInstalledApps([root], { ...source, path: "./" })).toEqual([root]);
    expect(matchingInstalledApps([app("one")], { ...source, path: "deploy/another" })).toEqual([]);
    expect(matchingInstalledApps([app("one")], { ...source, url: "https://git.example.test/team/another" })).toEqual([]);
  });

  test("destroyed apps and unsafe paths never count; scheduled removals still count", () => {
    const removed = app("gone", { state: "uninstalled" });
    const neverApplied = app("new", { state: "installing" });
    const scheduled = app("scheduled", { state: "uninstall_scheduled" });
    expect(matchingInstalledApps([removed, neverApplied, scheduled], source)).toEqual([scheduled]);
    for (const path of ["../deploy/app", "/deploy/app", "deploy/../app", ""]) {
      expect(matchingInstalledApps([app("one")], { ...source, path })).toEqual([]);
    }
  });

  test("Store comparison removes userinfo and hash but keeps query identity", () => {
    const selected = { ...source, url: "https://reader:private@git.example.test/team/app.git?variant=one#release" };
    const queried = app("queried", { installedFrom: selected });
    const queryless = app("queryless");
    expect(matchingInstalledApps([queryless], selected)).toEqual([]);
    expect(matchingInstalledApps([queried], source)).toEqual([]);
    expect(matchingInstalledApps([queried], { ...source, url: `${source.url}?variant=two` })).toEqual([]);
    expect(matchingInstalledApps([queried], { ...source, url: `${source.url}?variant=one` })).toEqual([queried]);
    expect(matchingInstalledApps([queryless], { ...source, url: "https://reader:private@git.example.test/team/app.git#release" })).toEqual([queryless]);
  });

  test("a value-free summary marked unmatchable never produces an installed badge", () => {
    const projected = app("projected", { installedFrom: { ...source, matchable: false } });
    expect(matchingInstalledApps([projected], source)).toEqual([]);
    expect(matchingInstalledApps([projected], { ...source, url: `${source.url}?variant=one` })).toEqual([]);
  });

  test("owner and repo case and scp/HTTPS spellings name the same repository", () => {
    const selected = app("one", { installedFrom: { ...source, url: "git@git.example.test:Team/App.git" } });
    expect(matchingInstalledApps([selected], { ...source, url: "https://git.example.test/team/app" })).toEqual([selected]);
    expect(matchingInstalledApps([selected], { ...source, url: "https://git.example.test/Team/Other" })).toEqual([]);
    expect(matchingInstalledApps([selected], { ...source, url: "http://git.example.test/team/app" })).toEqual([]);
  });

  test("value-free identities support URL SSH and scp without exposing userinfo", () => {
    for (const [raw, safe] of [
      ["https://reader:private@git.example.test/team/app.git?token=private#secret", "https://git.example.test/team/app.git"],
      ["ssh://git@git.example.test/team/app.git?token=private#secret", "ssh://git.example.test/team/app.git"],
      ["git@git.example.test:team/app.git?token=private#secret", "git.example.test:team/app.git"],
    ]) {
      expect(installedAppSourceUrl(raw!)).toBe(safe!);
      const summary = app("one", { installedFrom: { ...source, url: safe! } });
      expect(matchingInstalledApps([summary], { ...source, url: raw! })).toEqual([]);
      expect(matchingInstalledApps([summary], { ...source, url: raw!.split("?")[0]! })).toEqual([summary]);
    }
    expect(installedAppSourceUrl("file:///private/repo")).toBe("");
  });
});
