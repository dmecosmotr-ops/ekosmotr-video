import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

export default defineConfig({
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:3210' } },
  build: { outDir: 'dist', emptyOutDir: true },
  plugins: [{
    name: 'pdfjs-license',
    generateBundle() {
      const root = dirname(require.resolve('pdfjs-dist/package.json'));
      this.emitFile({ type: 'asset', fileName: 'pdfjs-LICENSE.txt', source: readFileSync(join(root, 'LICENSE')) });
    },
  }],
});
