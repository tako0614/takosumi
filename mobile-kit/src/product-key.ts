import type { MobileProductKind } from "./types.ts";
import { isTakosumiAppProductKey } from "../../contract/app-handoff.ts";

export function requireMobileProductKey(
  value: string,
  label = "product",
): MobileProductKind {
  if (isTakosumiAppProductKey(value)) return value;
  throw new Error(`${label} key is invalid.`);
}
