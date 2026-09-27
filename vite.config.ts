import { build } from 'vite';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * 開発サーバーでも「ゲームを書き出す」が使えるよう、書き出したゲームの本体
 * (player/pocket-player.js) を求められたときにその場でビルドして返す。
 * 本番のビルドでは vite.player.config.ts で dist/player/ に出力する。
 */
function devPlayer(): Plugin {
  return {
    name: 'pocket-dev-player',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.split('?')[0].endsWith('/player/pocket-player.js')) return next();
        try {
          const out = await build({ configFile: 'vite.player.config.ts', logLevel: 'warn', build: { write: false } });
          const outputs = Array.isArray(out) ? out : [out];
          const chunk = outputs.flatMap((o) => ('output' in o ? o.output : [])).find((c) => c.type === 'chunk');
          if (!chunk || chunk.type !== 'chunk') throw new Error('ビルド結果がありません');
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          res.end(chunk.code);
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
    },
  };
}

// GitHub Pages ではリポジトリ名のサブパス (例: /xxx/) で配信されるため、
// base を相対パス './' にしてどのパスでも動作するようにする。
export default defineConfig({
  base: './',
  plugins: [devPlayer()],
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
