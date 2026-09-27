import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', react: 'src/react/index.ts', styles: 'src/react/styles.css' },
  format: ['esm'],
  dts: { entry: { index: 'src/index.ts', react: 'src/react/index.ts' } },
  clean: true,
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});
