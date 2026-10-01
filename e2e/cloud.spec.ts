import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFakeLlm } from './fake-llm';
import { startHostProcess } from './host';

/**
 * 云端生成(BYOK)的 e2e:**不碰真网络、不花一分钱**。
 *
 * 覆盖三件事:
 * 1. 云端工具只估价 —— 聊天里出现估价卡、写着价钱,作品库此时一条都没多;
 * 2. 确认那一下走 /api/cloud/generate,没配 key 就如实报错(Host 里那条「还没配置…去设置里填」);
 *    真正发请求的部分要用真 key,所以本测试只验到门槛这一层;
 * 3. 设置里的「不用本机显卡」开关真的能把本机档位压成 none(/api/status 的 tier)。
 */
test('云端生成:估价不花钱、确认门槛、档位开关', async ({ page }) => {
  test.setTimeout(120_000);
  const root = join(process.cwd(), '.test-tmp', `cloud-e2e-${Date.now()}`);
  rmSync(root, { recursive: true, force: true });
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const keyFile = join(root, 'fake-key.txt');
  writeFileSync(keyFile, 'fake-deepseek-key-for-cloud-e2e');

  const fake = await startFakeLlm();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VIDROOM_DATA_DIR: dataDir,
    VIDROOM_DEEPSEEK_KEY_FILE: keyFile,
    VIDROOM_DEEPSEEK_BASE_URL: fake.baseURL,
  };
  const host = await startHostProcess(env);
  try {
    await page.goto(host.launchUrl);
    await expect(page.getByLabel('输入消息')).toBeEnabled();

    // 云端没配 key 时,/api/cloud 如实说两家都没配
    const before = await page.evaluate(async () => (await fetch('/api/cloud')).json());
    expect(before.providers.map((p: { configured: boolean }) => p.configured)).toEqual([false, false]);
    expect(before.prices.videoCentsPerSecond['720p']).toBe(60);

    // 聊天里说要用云端 → 模型调云端工具 → 页面出估价卡,此时一分钱没花
    await page.getByLabel('输入消息').fill('用云端生成一条视频');
    await page.getByRole('button', { name: '发送' }).click();
    const card = page.getByTestId('cloud-confirm');
    await expect(card).toContainText('¥3.00', { timeout: 30_000 });
    await expect(card).toContainText('确认生成(会计费)');
    await page.screenshot({ path: test.info().outputPath('cloud-estimate-card.png') });
    await expect(page.getByTestId('cloud-estimate-text')).toContainText('5 秒');
    expect(existsSync(join(dataDir, 'library', 'videos.json'))).toBe(false);

    // 点确认:真发请求这一步没有 key,Host 必须如实拒绝,并把原因显示出来
    await page.getByTestId('cloud-confirm-button').click();
    await expect(page.getByTestId('cloud-error')).toContainText('还没配置', { timeout: 30_000 });

    // 确认接口自己也有闸:不带 confirm:true 一律 400
    const noConfirm = await page.evaluate(async () => {
      const res = await fetch('/api/cloud/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'video', prompt: '一只橘猫', seconds: 5 }),
      });
      return { status: res.status, body: await res.json() };
    });
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error).toBe('needs_confirmation');

    // 设置里的「不用本机显卡」开关:档位压成 none,关掉后回到原来的档位
    const tier = async () =>
      page.evaluate(async () => {
        const s = await (await fetch('/api/status')).json();
        return { tier: s.tier as string, forced: s.forcedNoLocalGpu as boolean };
      });
    const original = await tier();
    await page.getByRole('button', { name: '设置' }).click();
    await expect(page.getByTestId('cloud-key-status')).toContainText('未配置');
    await page.screenshot({ path: test.info().outputPath('cloud-settings.png') });
    await page.getByTestId('force-no-gpu').check();
    await expect.poll(async () => (await tier()).tier).toBe('none');
    expect((await tier()).forced).toBe(true);
    await page.getByTestId('force-no-gpu').uncheck();
    await expect.poll(async () => (await tier()).tier).toBe(original.tier);
    expect((await tier()).forced).toBe(false);

    // 云端没配 key 而本机又跑不动时,首页给一条提示(档位压成 none 后再看)
    await page.getByTestId('force-no-gpu').check();
    await expect(page.getByTestId('cloud-hint')).toContainText('云端', { timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath('cloud-hint.png') });
    await page.getByTestId('force-no-gpu').uncheck();
  } finally {
    await host.stop();
    await fake.close();
  }
});
