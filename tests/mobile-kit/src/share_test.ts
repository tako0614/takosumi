import { expect, test } from "bun:test";
import { shareMobileUrl } from "../../../mobile-kit/src/index.ts";

test("shareMobileUrl prefers native Web Share", async () => {
  const shares: unknown[] = [];
  const clips: unknown[] = [];
  await shareMobileUrl({
    title: "Story",
    url: "https://host.example/stories/1",
    navigator: {
      async share(data) {
        shares.push(data);
      },
    },
    async writeClipboardText(input) {
      clips.push(input);
    },
  });

  expect(shares).toEqual([
    { title: "Story", url: "https://host.example/stories/1" },
  ]);
  expect(clips).toEqual([]);
});

test("shareMobileUrl falls back to native clipboard before browser clipboard", async () => {
  const clips: unknown[] = [];
  const browserClips: string[] = [];
  await shareMobileUrl({
    title: "Story",
    url: "https://host.example/stories/1",
    clipboardLabel: "Story URL",
    navigator: {
      clipboard: {
        async writeText(value) {
          browserClips.push(value);
        },
      },
    },
    async writeClipboardText(input) {
      clips.push(input);
    },
  });

  expect(clips).toEqual([
    { text: "https://host.example/stories/1", label: "Story URL" },
  ]);
  expect(browserClips).toEqual([]);
});

test("shareMobileUrl falls back to browser clipboard", async () => {
  const clips: string[] = [];
  await shareMobileUrl({
    url: "https://host.example/stories/1",
    navigator: {
      clipboard: {
        async writeText(value) {
          clips.push(value);
        },
      },
    },
  });

  expect(clips).toEqual(["https://host.example/stories/1"]);
});

test("shareMobileUrl reports unavailable share surfaces", async () => {
  await expect(
    shareMobileUrl({
      url: "https://host.example/stories/1",
      navigator: {},
      unavailableMessage: "No share target.",
    }),
  ).rejects.toThrow("No share target.");
});
