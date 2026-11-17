const STORAGE_PREFIX = "bb-tasks:list-search:";
export const LIST_SEARCH_MAX_LENGTH = 200;

const memoryFallback = new Map<string, string>();

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function sanitizeSearch(value: unknown): string {
  return typeof value === "string"
    ? value.slice(0, LIST_SEARCH_MAX_LENGTH)
    : "";
}

export function loadListSearch(scope: string): string {
  const store = sessionStore();
  if (store === null) return memoryFallback.get(scope) ?? "";
  try {
    return sanitizeSearch(store.getItem(STORAGE_PREFIX + scope));
  } catch {
    return memoryFallback.get(scope) ?? "";
  }
}

export function storeListSearch(scope: string, value: string): void {
  const search = sanitizeSearch(value);
  if (search.length === 0) memoryFallback.delete(scope);
  else memoryFallback.set(scope, search);
  try {
    const store = sessionStore();
    if (search.length === 0) store?.removeItem(STORAGE_PREFIX + scope);
    else store?.setItem(STORAGE_PREFIX + scope, search);
  } catch {}
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export function searchTerms(search: string): string[] {
  const trimmed = foldAsciiCase(search.trim());
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

export function matchesSearch(
  task: { key: string; title: string; description: string },
  terms: readonly string[],
): boolean {
  if (terms.length === 0) return true;
  const fields = [task.key, task.title, task.description].map(foldAsciiCase);
  return terms.every((term) => fields.some((field) => field.includes(term)));
}
