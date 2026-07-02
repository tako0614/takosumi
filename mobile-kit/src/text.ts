export interface CanSubmitMobileTextInput {
  readonly value: string;
  readonly disabled?: boolean;
  readonly maxLength?: number;
  readonly requireContent?: boolean;
}

export function mobileTextRemaining(value: string, maxLength: number): number {
  return maxLength - value.length;
}

export function mobileOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export interface MobilePlainTextOptions {
  readonly maxLength?: number;
}

export function mobilePlainText(
  value: unknown,
  options: MobilePlainTextOptions = {},
): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = mobileOptionalText(value.replace(/<[^>]*>/g, ""));
  if (!text) return undefined;
  if (typeof options.maxLength !== "number") return text;
  const length = Math.max(0, Math.trunc(options.maxLength));
  return Array.from(text).slice(0, length).join("");
}

export function isMobileTextPresent(value: string): boolean {
  return mobileOptionalText(value) !== undefined;
}

export function canSubmitMobileText(input: CanSubmitMobileTextInput): boolean {
  if (input.disabled) return false;
  if ((input.requireContent ?? true) && !isMobileTextPresent(input.value)) {
    return false;
  }
  return (
    typeof input.maxLength !== "number" || input.value.length <= input.maxLength
  );
}
