import { defineConfig, devices } from '@playwright/test';

/**
 * E2E テスト設定。
 * GitHub Pages と同じく「サブパス (/xxx/)」でビルド成果物を配信し、
 * スマートフォン縦画面 (タッチ操作) と PC (マウス操作) の両方で検証する。
 */
const BASE_PATH = process.env.PE_BASE_PATH ?? '/xxx/';
const PORT = Number(process.env.PE_PORT ?? 4173);
/** 公開済みの URL (GitHub Pages など) を直接テストする場合に指定 */
const REMOTE_URL = process.env.PE_REMOTE_URL;
const baseURL = REMOTE_URL ? (REMOTE_URL.endsWith('/') ? REMOTE_URL : `${REMOTE_URL}/`) : `http://localhost:${PORT}${BASE_PATH}`;

// ローカル環境で Playwright 同梱以外の Chromium を使う場合に指定
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath,
      // CI などの GPU の無い環境でも WebGL を使えるようにする
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [
    {
      name: 'mobile-portrait',
      use: { ...devices['iPhone 13'], browserName: 'chromium' },
      testIgnore: /desktop\.spec\.ts/,
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
      testMatch: /desktop\.spec\.ts/,
    },
  ],
  webServer: REMOTE_URL
    ? undefined
    : {
        command: `npm run build && npx vite preview --port ${PORT} --strictPort --base ${BASE_PATH}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
