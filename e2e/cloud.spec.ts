import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
 * 3. 设置里的「不用本机显卡」开关真的能把本机档位压成 none(/api/status 的 tier),
 *    且这时本地出片入口隐藏、云端入口出现(合同第 6b 批验收①)。
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

    // 云端没配 key 而本机又跑不动时:本地出片入口(「MiniMax H3 出片」)整个不显示,换成云端入口
    // —— 合同第 6b 批验收①要的就是这两件事一起发生
    await page.getByTestId('force-no-gpu').check();
    await expect(page.getByTestId('cloud-panel')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('cloud-hint')).toContainText('云端');
    await expect(page.getByTestId('h3-panel')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('cloud-hint.png') });
    await page.getByTestId('force-no-gpu').uncheck();
    await expect(page.getByTestId('h3-panel')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('cloud-panel')).toHaveCount(0);
  } finally {
    await host.stop();
    await fake.close();
  }
});

/**
 * 合同第 6b 批验收③:用假 key 测 —— key 不出现在日志、数据库、作品目录里。
 *
 * 真发请求这一步靠不住真网络:把厂商 baseURL 指到一个只会回 500 的本地栈,
 * 于是这次生成必定失败(也正好验了失败路径),但 key 已经进过 Host 进程了。
 */
test('假 key 不进日志、数据目录与作品目录', async ({ page }) => {
  test.setTimeout(120_000);
  const MARKER = 'FAKE-CLOUD-KEY-MARKER-6b';
  const root = join(process.cwd(), '.test-tmp', `cloud-key-e2e-${Date.now()}`);
  rmSync(root, { recursive: true, force: true });
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const llmKeyFile = join(root, 'fake-key.txt');
  writeFileSync(llmKeyFile, 'fake-deepseek-key-for-cloud-e2e');
  const cloudKeyFile = join(root, 'cloud-video-key.txt');
  writeFileSync(cloudKeyFile, MARKER);

  // 假的「厂商」:任何请求一律 500,不进真网络、不花钱
  const vendor = createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"stub vendor"}}');
  });
  await new Promise<void>((resolve) => vendor.listen(0, '127.0.0.1', resolve));
  const vendorUrl = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}`;

  const fake = await startFakeLlm();
  const host = await startHostProcess({
    ...process.env,
    VIDROOM_DATA_DIR: dataDir,
    VIDROOM_DEEPSEEK_KEY_FILE: llmKeyFile,
    VIDROOM_DEEPSEEK_BASE_URL: fake.baseURL,
    VIDROOM_CLOUD_VIDEO_KEY_FILE: cloudKeyFile,
    VIDROOM_CLOUD_VIDEO_BASE_URL: vendorUrl,
  });
  try {
    await page.goto(host.launchUrl);
    // key 已配:设置页只能说「已配置」,拿不到明文
    await page.getByRole('button', { name: '设置' }).click();
    await expect(page.getByTestId('cloud-key-status')).toContainText('已配置');
    expect(await page.content()).not.toContain(MARKER);
    await page.getByRole('button', { name: '返回' }).click();

    // 走一遍真花钱那一下:请求打到假厂商、必定失败,错误如实显示
    await page.getByLabel('输入消息').fill('用云端生成一条视频');
    await page.getByRole('button', { name: '发送' }).click();
    await page.getByTestId('cloud-confirm-button').click();
    await expect(page.getByTestId('cloud-error')).toContainText('云端生成失败', { timeout: 60_000 });

    // 验收③:key 不在日志里
    expect(host.output()).not.toContain(MARKER);
    // 也不在页面、数据目录、作品目录里(数据目录里除了 Web 自己的 cookie/token,不该有 key)
    expect(await page.content()).not.toContain(MARKER);
    for (const file of walk(dataDir)) {
      const bytes = readFileSync(file);
      if (bytes.includes(MARKER)) throw new Error(`key 落在了 ${file}`);
    }
    // 失败的那次没往作品库里写任何东西
    expect(existsSync(join(dataDir, 'library', 'videos.json'))).toBe(false);
  } finally {
    await host.stop();
    await fake.close();
    await new Promise<void>((resolve) => vendor.close(() => resolve()));
  }
});

/** 递归列出目录下的普通文件(测试用,数据目录很小) */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
