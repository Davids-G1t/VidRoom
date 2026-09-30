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
    // Playwright 驱动 Electron 桌面版;CI 上驱动静默安装好的 exe(VIDROOM_DESKTOP_EXE)
    { name: 'desktop', testMatch: /desktop\.spec\.ts/ },
    // 「启动 / 打开 ComfyUI」:默认假 ComfyUI(要 Python),本机和 CI 都跑;设了 VIDROOM_COMFYUI_DIR 就用真的
    { name: 'comfyui', testMatch: /comfyui\.spec\.ts/ },
    // MiniMax H3 出片全链路(假 ComfyUI 回放 + 假 LLM),开发机跑:要 VIDROOM_E2E_H3_MODELS_DIR 和 15 GiB 以上显存的 NVIDIA 显卡
    { name: 'h3', testMatch: /h3\.spec\.ts/ },
    // 滥用测试:真 DeepSeek(VIDROOM_DEEPSEEK_KEY_FILE)+ 假 ComfyUI 回放,开发机跑
    { name: 'abuse', testMatch: /abuse\.spec\.ts/ },
  ],
});
