import { describe, expect, test } from "bun:test";
import {
  parseCompositionInstallLink,
  parseCompositionManifest,
  parseCompositionManifestText,
} from "../../../../dashboard/src/lib/composition-manifest.ts";

const validManifest = {
  apiVersion: "compositions.takoform.com/v1alpha1",
  kind: "CapsuleComposition",
  metadata: {
    name: "yurucommu-standalone",
    version: "1.0.0",
    title: "Yurucommu",
  },
  components: [
    {
      id: "yurucommu",
      title: "Yurucommu",
      source: {
        url: "https://github.com/tako0614/yurucommu.git",
        ref: "b993b9a1711deb6e68f9521ad129775ad4f2d1a2",
        path: ".",
      },
    },
  ],
};

describe("Capsule Composition Manifest", () => {
  test("parses a Git SourceSnapshot composition selector", () => {
    expect(
      parseCompositionInstallLink(
        "?kind=composition&git=https%3A%2F%2Fgithub.com%2Ftako0614%2Ftakoform.git&ref=abc123&path=compositions%2Fyurucommu-standalone.json",
      ),
    ).toEqual({
      git: "https://github.com/tako0614/takoform.git",
      ref: "abc123",
      path: "compositions/yurucommu-standalone.json",
    });
  });

  test("rejects credential-bearing Git URLs and unsafe manifest paths", () => {
    expect(
      parseCompositionInstallLink(
        "?kind=composition&git=https%3A%2F%2Fuser%3Apw%40github.com%2Facme%2Frepo.git&ref=main&path=compositions%2Fapp.json",
      ),
    ).toBeUndefined();
    expect(
      parseCompositionInstallLink(
        "?kind=composition&git=https%3A%2F%2Fgithub.com%2Facme%2Frepo.git&ref=main&path=..%2Fapp.json",
      ),
    ).toBeUndefined();
  });

  test("admits only closed portable selection data", () => {
    expect(parseCompositionManifest(validManifest)).toMatchObject({
      metadata: { name: "yurucommu-standalone" },
    });
    expect(() =>
      parseCompositionManifest({
        ...validManifest,
        components: [
          {
            ...validManifest.components[0],
            providerConnectionId: "pc_123",
          },
        ],
      }),
    ).toThrow("closed object");
  });

  test("parses SourceSnapshot text and derives its canonical display digest", async () => {
    const loaded = await parseCompositionManifestText(
      JSON.stringify(validManifest),
    );
    expect(loaded.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
});
