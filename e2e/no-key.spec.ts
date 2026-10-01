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
  test(`不给 key(${c.title}):页面提示去设置,工作流库可见`, async ({ page, request }) => {
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
      // 工作流库本身一直在;里面那个「运行」在不在要看这台机器出不出得了片(合同第 6b 批验收①):
      // 有本机出片的档位就在,没显卡档就换成一行说明 —— 云上跑和本机跑是两件不同的事
      const status = (await page.evaluate(async () => (await fetch('/api/status')).json())) as { tier: string };
      const localCanGen = status.tier !== 'none' && status.tier !== 'unsupported';
      if (localCanGen) {
        await expect(workflows.getByRole('button', { name: '运行' })).not.toHaveCount(0);
      } else {
        await expect(workflows.getByRole('button', { name: '运行' })).toHaveCount(0);
        await expect(page.getByTestId('workflow-local-disabled').first()).toBeVisible();
      }
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
