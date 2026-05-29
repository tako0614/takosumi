import { assert } from "jsr:@std/assert@^1.0.0";
import {
  constantTimeEqualsBytes,
  constantTimeEqualsString,
} from "./constant_time.ts";

Deno.test("constantTimeEqualsString matches equal strings and rejects differences", () => {
  assert(constantTimeEqualsString("bearer-token", "bearer-token"));
  assert(!constantTimeEqualsString("bearer-token", "bearer-tokem"));
  // Length mismatch must not be treated as equal (and is folded into the
  // accumulator rather than short-circuited).
  assert(!constantTimeEqualsString("short", "short-but-longer"));
  assert(!constantTimeEqualsString("", "x"));
  assert(constantTimeEqualsString("", ""));
});

Deno.test("constantTimeEqualsString compares multi-byte characters end-to-end", () => {
  assert(constantTimeEqualsString("トークン", "トークン"));
  assert(!constantTimeEqualsString("トークン", "トークソ"));
});

Deno.test("constantTimeEqualsBytes matches equal byte arrays and rejects differences", () => {
  assert(
    constantTimeEqualsBytes(
      new Uint8Array([1, 2, 3]),
      new Uint8Array([1, 2, 3]),
    ),
  );
  assert(
    !constantTimeEqualsBytes(
      new Uint8Array([1, 2, 3]),
      new Uint8Array([1, 2, 4]),
    ),
  );
  assert(
    !constantTimeEqualsBytes(
      new Uint8Array([1, 2]),
      new Uint8Array([1, 2, 3]),
    ),
  );
});
