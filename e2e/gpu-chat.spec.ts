import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { startHostProcess } from './host';

/**
 * 开发机专用:真显卡 + 真 DeepSeek key。前提不满足直接失败,不跳过。
 * 断言回答里的型号与显存来自 probe_gpu 工具,并与测试自己跑的 nvidia-smi 一致。
 */
test('问「我这台电脑能跑什么」:回答给出真实型号与显存,且来自 probe_gpu 工具', async ({ page }) => {
  const keyFile = process.env.VIDROOM_DEEPSEEK_KEY_FILE;
  expect(keyFile, '需要设置 VIDROOM_DEEPSEEK_KEY_FILE').toBeTruthy();
  expect(existsSync(keyFile!), 'VIDROOM_DEEPSEEK_KEY_FILE 指向的文件不存在').toBe(true);

  // ground truth:测试自己独立跑一次 nvidia-smi
  const smi = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], {
    encoding: 'utf8',
  });
  expect(smi.status, '本机需要能跑 nvidia-smi').toBe(0);
  const [truthName, truthMiBText] = smi.stdout.trim().split(/\r?\n/)[0].split(',').map((s) => s.trim());
  const truthMiB = Number(truthMiBText);
  const truthGiB = Math.round(truthMiB / 1024);
  const shortName = truthName.replace(/^NVIDIA\s+(GeForce\s+)?/i, ''); // 如 "RTX 4060 Ti"
  console.log(`[ground truth] ${truthName}, ${truthMiB} MiB (~${truthGiB} GiB)`);

  const host = await startHostProcess({ ...process.env });
  try {
    await page.goto(host.launchUrl);
    await expect(page).toHaveURL(`${host.origin}/`);
    const box = page.getByLabel('输入消息');
    await expect(box).toBeEnabled();

    await box.fill('我这台电脑能跑什么');
    const responsePromise = page.waitForResponse((r) => r.url().endsWith('/api/chat'), { timeout: 110_000 });
    await page.getByRole('button', { name: '发送' }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const body = await response.json();

    // 1) 工具真的被调用,且工具返回的数字 = ground truth
    const call = body.toolCalls.find((t: { toolName: string }) => t.toolName === 'probe_gpu');
    expect(call, `没有调用 probe_gpu:${JSON.stringify(body.toolCalls)}`).toBeTruthy();
    expect(call.output.primary.name).toBe(truthName);
    expect(call.output.primary.memoryMiB).toBe(truthMiB);
    console.log(`[tool call] ${JSON.stringify(call)}`);

    // 2) 页面上 LLM 回答正文(不含折叠的工具调用 JSON)里出现型号与显存
    const answer = page.getByTestId('message-assistant').last().getByTestId('message-content');
    await expect(answer).toBeVisible();
    const text = (await answer.textContent()) ?? '';
    expect(text).toBe(body.text);
    console.log(`[answer] ${text}`);
    const nameRe = new RegExp(shortName.replace(/\s+/g, '\\s*'), 'i');
    const memRe = new RegExp(`${truthGiB}\\s*(GB|GiB|G\\b|吉)|${truthMiB}\\s*MiB`, 'i');
    expect(text).toMatch(nameRe);
    expect(text).toMatch(memRe);

    // 3) key 不出现在响应与 Host 控制台输出里
    const key = readFileSync(keyFile!, 'utf8').trim();
    expect(JSON.stringify(body).includes(key)).toBe(false);
    expect(host.output().includes(key)).toBe(false);

    await page.screenshot({ path: 'test-results/gpu-chat.png', fullPage: true });
  } finally {
    await host.stop();
  }
});
