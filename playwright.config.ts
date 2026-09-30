import { defineConfig } from '@playwright/test';

// 先 `pnpm build` 出聊天页,再跑。Host 由各测试自己起(见 e2e/host.ts)。
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  reporter: 'list',
  use: { browserName: 'chromium', headless: true },
  projects: [
    // 不需要 key 和显卡,本机与 CI 都跑
    { name: 'no-key', testMatch: /no-key\.spec\.ts/ },
    // 需要真显卡 + 真 DeepSeek key(VIDROOM_DEEPSEEK_KEY_FILE),只在开发机跑
    { name: 'gpu', testMatch: /gpu-chat\.spec\.ts/ },
  ],
});
