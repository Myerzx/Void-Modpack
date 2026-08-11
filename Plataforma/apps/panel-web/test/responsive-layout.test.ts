import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const app = new URL('../app/', import.meta.url);

describe('desktop responsive shell', () => {
  it('uses one shell for the overview and operational configuration screens', async () => {
    const [overview, configuration] = await Promise.all([
      readFile(new URL('page.tsx', app), 'utf8'),
      readFile(new URL('configuracoes/page.tsx', app), 'utf8'),
    ]);
    assert.match(overview, /<PanelShell/u);
    assert.doesNotMatch(overview, /className="app-shell"/u);
    assert.match(configuration, /<PanelShell/u);
    assert.match(configuration, /serverSteps\('settings'\)/u);
  });

  it('compacts navigation before the minimum desktop window and preserves table access', async () => {
    const css = await readFile(new URL('globals.css', app), 'utf8');
    assert.match(css, /@media \(max-width: 1180px\)/u);
    assert.match(css, /\.shell \{ grid-template-columns: 72px minmax\(0, 1fr\); \}/u);
    assert.match(css, /\.table-scroll \{ min-width: 0; overflow-x: auto; \}/u);
    assert.match(css, /\.shell-body \{ width: min\(100%, 1460px\);/u);
  });
});
