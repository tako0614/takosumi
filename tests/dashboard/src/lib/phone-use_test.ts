import { describe, expect, test } from "bun:test";
import {
  canShareUrl,
  copyUrl,
  detectPhonePlatform,
  phoneGuidanceOrder,
  phoneLaunchUrl,
  QR_QUIET_ZONE,
  qrCodeSvg,
  type ShareEnvironment,
  shareOrCopyUrl,
} from "../../../../dashboard/src/lib/phone-use.ts";

/** Paint the SVG path back into a module matrix (true = dark). */
function modulesOf(svg: { readonly size: number; readonly path: string }): boolean[][] {
  const grid = Array.from({ length: svg.size }, () => new Array<boolean>(svg.size).fill(false));
  const commands = [...svg.path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/gu)];
  // Every byte of the path is one of these run commands.
  expect(commands.map((match) => match[0]).join("")).toBe(svg.path);
  for (const [, x, y, width, back] of commands) {
    expect(back).toBe(width);
    for (let index = 0; index < Number(width); index += 1) {
      const row = grid[Number(y)]!;
      expect(row[Number(x) + index]).toBe(false);
      row[Number(x) + index] = true;
    }
  }
  return grid;
}

function expectFinder(grid: boolean[][], left: number, top: number): void {
  for (let dy = 0; dy < 7; dy += 1) {
    for (let dx = 0; dx < 7; dx += 1) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      expect({ dx, dy, dark: grid[top + dy]![left + dx] }).toEqual({ dx, dy, dark: ring !== 2 });
    }
  }
}

/** The 15 format bits next to the top-left finder (ISO/IEC 18004 7.9). */
function formatBits(grid: boolean[][]): number {
  const at = (x: number, y: number) => (grid[y + QR_QUIET_ZONE]![x + QR_QUIET_ZONE] ? 1 : 0);
  const cells: [number, number][] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  return cells.reduce((bits, [x, y], index) => bits | (at(x, y) << index), 0) ^ 0x5412;
}

function bchRemainder(data: number): number {
  let remainder = data;
  for (let index = 0; index < 10; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return remainder & 0x3ff;
}

describe("the URL a phone opens", () => {
  test("is an absolute http(s) address, like Open", () => {
    expect(phoneLaunchUrl("https://yurucommu.example.com/")).toBe("https://yurucommu.example.com/");
    expect(phoneLaunchUrl(" http://127.0.0.1:8787/app ")).toBe("http://127.0.0.1:8787/app");
  });

  test("anything else gets no QR code and no share action", () => {
    for (const value of [undefined, "", "/apps/cap_1", "javascript:alert(1)", "data:text/html,x", "ftp://example.test/"]) {
      expect({ value, url: phoneLaunchUrl(value) }).toEqual({ value, url: undefined });
    }
  });
});

describe("QR code of an app URL", () => {
  const url = "https://app-7f3k2.takosumi.app/home?ref=qr&lang=ja";

  test("is a square code with its quiet zone, finder patterns and error correction M", () => {
    const svg = qrCodeSvg(url)!;
    expect(svg).toBeDefined();
    const symbol = svg.size - QR_QUIET_ZONE * 2;
    const version = (symbol - 17) / 4;
    expect(Number.isInteger(version) && version >= 1 && version <= 40).toBe(true);

    const grid = modulesOf(svg);
    for (let y = 0; y < svg.size; y += 1) {
      for (let x = 0; x < svg.size; x += 1) {
        const inQuietZone = x < QR_QUIET_ZONE || y < QR_QUIET_ZONE ||
          x >= svg.size - QR_QUIET_ZONE || y >= svg.size - QR_QUIET_ZONE;
        if (inQuietZone) expect({ x, y, dark: grid[y]![x] }).toEqual({ x, y, dark: false });
      }
    }
    const far = QR_QUIET_ZONE + symbol - 7;
    expectFinder(grid, QR_QUIET_ZONE, QR_QUIET_ZONE);
    expectFinder(grid, far, QR_QUIET_ZONE);
    expectFinder(grid, QR_QUIET_ZONE, far);

    const format = formatBits(grid);
    const data = format >>> 10;
    expect(format & 0x3ff).toBe(bchRemainder(data));
    // Error-correction bits 00 are level M; the low three bits are the mask.
    expect(data >>> 3).toBe(0);
  });

  test("is deterministic and differs per URL", () => {
    expect(qrCodeSvg(url)).toEqual(qrCodeSvg(url));
    expect(qrCodeSvg(`${url}x`)?.path).not.toBe(qrCodeSvg(url)?.path);
  });

  test("a non-ASCII URL still encodes", () => {
    expect(qrCodeSvg("https://日本語.example/パス?q=値")).toBeDefined();
  });

  test("no code for nothing or for more than a QR code holds", () => {
    expect(qrCodeSvg("")).toBeUndefined();
    expect(qrCodeSvg(`https://example.test/${"a".repeat(5000)}`)).toBeUndefined();
  });
});

function fakeEnvironment(options: {
  readonly share?: (data: ShareData) => Promise<void>;
  readonly canShare?: (data: ShareData) => boolean;
  readonly writeText?: (text: string) => Promise<void>;
} = {}): ShareEnvironment & { readonly shared: ShareData[]; readonly copied: string[] } {
  const shared: ShareData[] = [];
  const copied: string[] = [];
  return {
    shared,
    copied,
    ...(options.share
      ? { share: async (data: ShareData) => { shared.push(data); await options.share!(data); } }
      : {}),
    ...(options.canShare ? { canShare: options.canShare } : {}),
    writeText: async (text: string) => {
      copied.push(text);
      if (options.writeText) await options.writeText(text);
    },
  };
}

const data = { title: "Yurucommu", url: "https://yurucommu.example.com/" };
const domError = (name: string) => Object.assign(new Error(name), { name });

describe("sharing the app URL", () => {
  test("opens the share sheet where the browser has one", async () => {
    const env = fakeEnvironment({ share: async () => {} });
    expect(canShareUrl(data, env)).toBe(true);
    expect(await shareOrCopyUrl(data, env)).toBe("shared");
    expect(env.shared).toEqual([data]);
    expect(env.copied).toEqual([]);
  });

  test("copies where there is no share sheet", async () => {
    const env = fakeEnvironment();
    expect(canShareUrl(data, env)).toBe(false);
    expect(await shareOrCopyUrl(data, env)).toBe("copied");
    expect(env.copied).toEqual([data.url]);
  });

  test("copies where the browser declines this payload", async () => {
    const env = fakeEnvironment({ share: async () => {}, canShare: () => false });
    expect(canShareUrl(data, env)).toBe(false);
    expect(await shareOrCopyUrl(data, env)).toBe("copied");
    expect(env.shared).toEqual([]);
    expect(env.copied).toEqual([data.url]);
  });

  test("a canShare that throws counts as no share sheet", () => {
    const env = fakeEnvironment({ share: async () => {}, canShare: () => { throw new TypeError("bad"); } });
    expect(canShareUrl(data, env)).toBe(false);
  });

  test("closing the sheet copies nothing behind the person's back", async () => {
    const env = fakeEnvironment({ share: async () => { throw domError("AbortError"); } });
    expect(await shareOrCopyUrl(data, env)).toBe("cancelled");
    expect(env.copied).toEqual([]);
  });

  test("a refused share sheet still hands the URL over by copying", async () => {
    const env = fakeEnvironment({ share: async () => { throw domError("NotAllowedError"); } });
    expect(await shareOrCopyUrl(data, env)).toBe("copied");
    expect(env.copied).toEqual([data.url]);
  });

  test("copying reports failure so the visible URL can be copied by hand", async () => {
    const refused = fakeEnvironment({ writeText: async () => { throw domError("NotAllowedError"); } });
    expect(await copyUrl(data.url, refused)).toBe("failed");
    expect(await shareOrCopyUrl(data, refused)).toBe("failed");
    expect(await copyUrl(data.url, {})).toBe("failed");
  });
});

describe("add-to-home-screen guidance", () => {
  const agents = {
    iphone:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    ipadDesktop:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    android:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
    windows:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  };

  test("detects iPhone, iPad (also with the desktop agent) and Android", () => {
    expect(detectPhonePlatform({ userAgent: agents.iphone, maxTouchPoints: 5 })).toBe("ios");
    expect(detectPhonePlatform({ userAgent: agents.ipadDesktop, maxTouchPoints: 5 })).toBe("ios");
    expect(detectPhonePlatform({ userAgent: agents.android, maxTouchPoints: 5 })).toBe("android");
  });

  test("a computer is no phone", () => {
    expect(detectPhonePlatform({ userAgent: agents.ipadDesktop, maxTouchPoints: 0 })).toBeUndefined();
    expect(detectPhonePlatform({ userAgent: agents.windows })).toBeUndefined();
  });

  test("both phones' steps are always listed, the detected one first", () => {
    expect(phoneGuidanceOrder("android")).toEqual(["android", "ios"]);
    expect(phoneGuidanceOrder("ios")).toEqual(["ios", "android"]);
    expect(phoneGuidanceOrder(undefined)).toEqual(["ios", "android"]);
  });
});
