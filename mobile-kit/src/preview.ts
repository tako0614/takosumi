export function formatMobilePreviewDate(
  value: string,
  locales?: Intl.LocalesArgument,
  options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  },
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locales, options);
}

export function appendUniqueMobileItemsById<
  Item extends { readonly id: string },
>(current: readonly Item[], next: readonly Item[]): readonly Item[] {
  return appendUniqueMobileItemsByKey(current, next, (item) => item.id);
}

export function appendUniqueMobileItemsByKey<Item>(
  current: readonly Item[],
  next: readonly Item[],
  keyOf: (item: Item) => string,
): readonly Item[] {
  if (next.length === 0) return current;
  const knownKeys = new Set(current.map(keyOf));
  return [
    ...current,
    ...next.filter((item) => {
      const key = keyOf(item);
      if (knownKeys.has(key)) return false;
      knownKeys.add(key);
      return true;
    }),
  ];
}

export function prependUniqueMobileItemsByKey<Item>(
  previous: readonly Item[],
  current: readonly Item[],
  keyOf: (item: Item) => string,
): readonly Item[] {
  if (previous.length === 0) return current;
  const knownKeys = new Set(current.map(keyOf));
  const fresh = previous.filter((item) => {
    const key = keyOf(item);
    if (knownKeys.has(key)) return false;
    knownKeys.add(key);
    return true;
  });
  return fresh.length ? [...fresh, ...current] : current;
}
