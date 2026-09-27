import { defineConfig } from 'vite';

/**
 * 書き出したゲームの本体 (pocket-player.js) のビルド。
 * エディタとは別に、1 つのファイル (IIFE・CSS 込み) にまとめて dist/player/ に出力する。
 * エディタは「ゲームを書き出す」ときにこのファイルを読み込んで ZIP / HTML に入れる。
 * <script src> でも file:// でも動くよう、ES モジュールではなく普通のスクリプトにする。
 */
export default defineConfig({
  base: './',
  publicDir: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    target: 'es2022',
    outDir: 'dist/player',
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
    chunkSizeWarningLimit: 3000,
    lib: {
      entry: 'src/player/main.ts',
      name: 'PocketPlayer',
      formats: ['iife'],
      fileName: () => 'pocket-player.js',
    },
  },
});
