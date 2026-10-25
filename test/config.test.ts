import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSearches } from '../src/config.js';

function load(yaml: string) {
  const path = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'searches.yaml');
  writeFileSync(path, yaml);
  return loadSearches(path);
}

const U = 'https://auto.ria.com/uk/search/?a=1';

describe('loadSearches', () => {
  it('loads searches and defaults enabled to true', () => {
    const r = load(`searches:\n  - {name: A, url: "${U}"}\n  - {name: B, url: "${U}", enabled: false}\n`);
    expect(r).toEqual([
      { name: 'A', url: U, enabled: true },
      { name: 'B', url: U, enabled: false },
    ]);
  });

  it('loads the shipped searches file', () => {
    expect(loadSearches('searches.yaml').length).toBeGreaterThan(0);
  });

  it.each([
    ['missing list', 'foo: 1\n', /"searches" list/],
    ['empty name', `searches:\n  - {name: "", url: "${U}"}\n`, /name/],
    ['duplicate names', `searches:\n  - {name: A, url: "${U}"}\n  - {name: A, url: "${U}"}\n`, /duplicate/],
    ['foreign url', 'searches:\n  - {name: A, url: "https://example.com/"}\n', /url/],
    ['bad enabled', `searches:\n  - {name: A, url: "${U}", enabled: "yes"}\n`, /enabled/],
  ])('rejects %s', (_label, yaml, msg) => {
    expect(() => load(yaml)).toThrow(msg);
  });
});

describe('search url shape', () => {
  it('rejects category pages that ignore filter params', () => {
    expect(() => load(`searches:\n  - name: x\n    url: https://auto.ria.com/uk/legkovie/toyota/camry/\n`)).toThrow(/search URL/);
  });
});
