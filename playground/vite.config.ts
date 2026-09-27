import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// playground はビルド前のソースを直接参照する（ライブラリを編集すると即反映）
const src = (p: string) => fileURLToPath(new URL(`../src/${p}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^org-chart-kit\/react$/, replacement: src('react/index.ts') },
      { find: /^org-chart-kit\/styles\.css$/, replacement: src('react/styles.css') },
      { find: /^org-chart-kit$/, replacement: src('index.ts') },
    ],
  },
});
