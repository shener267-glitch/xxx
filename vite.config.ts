import { defineConfig } from 'vitest/config';

// GitHub Pages ではリポジトリ名のサブパス (例: /xxx/) で配信されるため、
// base を相対パス './' にしてどのパスでも動作するようにする。
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    host: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
