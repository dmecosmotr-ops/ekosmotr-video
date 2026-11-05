import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite, Login;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('.', import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  ({ Login } = await vite.ssrLoadModule('/src/screens.jsx'));
});
after(async () => { await vite?.close(); });

test('server login and unknown policy never offer demo users or prefill their email', () => {
  for (const props of [{}, { demoLoginAvailable: false }]) {
    const html = renderToStaticMarkup(React.createElement(Login, { ...props, onLogin() {} }));
    assert.doesNotMatch(html, /demo-login|Проверить пилот в роли|admin@ekosmotr\.local/);
    assert.match(html, /autocomplete="username"/i);
  }
});
test('explicit local policy preserves the existing local role buttons', () => {
  const html = renderToStaticMarkup(React.createElement(Login, { demoLoginAvailable: true, onLogin() {} }));
  assert.match(html, /Проверить пилот в роли/);
  assert.match(html, /admin@ekosmotr\.local/);
  assert.match(html, />Регионал<\/button>/);
});
