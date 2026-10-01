import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import { envWithoutKey, startHostProcess } from './host';

const cases = [
  { title: '没设 VIDROOM_DEEPSEEK_KEY_FILE', env: () => envWithoutKey() },
  {
    title: 'VIDROOM_DEEPSEEK_KEY_FILE 指向不存在的文件',
    env: () => ({ ...envWithoutKey(), VIDROOM_DEEPSEEK_KEY_FILE: join(tmpdir(), 'vidroom-no-such-key-file') }),
  },
];

for (const c of cases) {
  test(`不给 key(${c.title}):页面提示去设置,预设工作流入口可见`, async ({ page, request }) => {
    const host = await startHostProcess(c.env());
    try {
      // 不带 cookie 的 API 请求被拒
      expect((await request.get(`${host.origin}/api/status`)).status()).toBe(401);

      await page.goto(host.launchUrl);
      await expect(page).toHaveURL(`${host.origin}/`);

      const notice = page.getByTestId('no-key-notice');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('没有配置 API key');
      await expect(notice.getByRole('link', { name: '去设置' })).toBeVisible();

      const workflows = page.getByTestId('workflow-library');
      await expect(workflows).toBeVisible();
      await expect(workflows.getByRole('button', { name: '运行' })).not.toHaveCount(0);
      await expect(page.getByLabel('输入消息')).toBeDisabled();

      // 启动地址只能兑换一次
      const again = await request.get(host.launchUrl, { maxRedirects: 0 });
      expect(again.status()).toBe(403);

      await page.screenshot({ path: `test-results/no-key-${cases.indexOf(c)}.png`, fullPage: true });
    } finally {
      await host.stop();
    }
  });
}
