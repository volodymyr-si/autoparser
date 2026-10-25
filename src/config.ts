import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { SearchConfig } from './types.js';

// Only the search page accepts filter params; category pages like /uk/legkovie/toyota/ don't.
const SEARCH_URL = /^https:\/\/auto\.ria\.com\/(uk\/|ru\/)?search\/\?/;

export function loadSearches(path = 'searches.yaml'): SearchConfig[] {
  const doc = parse(readFileSync(path, 'utf8')) as { searches?: unknown } | null;
  if (!doc || !Array.isArray(doc.searches)) {
    throw new Error(`${path}: expected a top-level "searches" list`);
  }
  const names = new Set<string>();
  return doc.searches.map((raw: unknown, i: number) => {
    const where = `${path}: searches[${i}]`;
    const item = (raw ?? {}) as Record<string, unknown>;
    const { name, url, enabled = true } = item;
    if (typeof name !== 'string' || name.trim() === '') throw new Error(`${where}: "name" must be a non-empty string`);
    if (names.has(name)) throw new Error(`${where}: duplicate name "${name}"`);
    names.add(name);
    if (typeof url !== 'string' || !SEARCH_URL.test(url)) {
      throw new Error(
        `${where} ("${name}"): "url" must be an auto.ria.com search URL like https://auto.ria.com/uk/search/?... ` +
          '(press "Пошук" after setting filters and copy the address bar)',
      );
    }
    if (typeof enabled !== 'boolean') throw new Error(`${where} ("${name}"): "enabled" must be true or false`);
    return { name, url, enabled };
  });
}
