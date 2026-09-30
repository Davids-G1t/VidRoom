import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { ensureFfmpeg } from '../apps/host/src/ffmpeg/install';
import { MOTION_CALL, startFakeLlm } from './fake-llm';
import { startHostProcess } from './host';

/**
 * 代码渲染端到端(验收①的 CI 版,本机和 CI 都跑):聊一句「做一条10秒的开场动画,标题是VidRoom」→
 * 假 LLM 回放录好的 render_motion 调用(不调真 LLM)→ Host 走真的 HyperFrames + chrome-headless-shell + LGPL ffmpeg
 * 渲染、编码、自检、入库 → ffprobe 量时长 10 秒、联系表 PNG 在作品目录里、作品库卡片标「代码渲染」。
 *
 * 浏览器与 ffmpeg 都按清单首次下载(Windows CI 上这就是「浏览器下载 + 渲染」这条路径的验证)。
 * 数据目录默认放仓库里的 .test-tmp/motion-e2e(已 gitignore,在磁盘上,不用系统临时目录);
 * 保留下载好的浏览器与 ffmpeg 供下次复用,只清掉作品库。VIDROOM_E2E_MOTION_DATA_DIR 可改位置。
 * 前提:pnpm build(聊天页)、pnpm hyperframes:install(HyperFrames CLI)。
 *
 * 设了 VIDROOM_E2E_ELECTRON(Electron 或装好的 VidRoom.exe)就按桌面版的跑法起 Host:ELECTRON_RUN_AS_NODE=1 跑
 * VIDROOM_E2E_HOST_SCRIPT(打包好的 host.mjs),HyperFrames 取 VIDROOM_E2E_HYPERFRAMES_DIR、聊天页取 VIDROOM_E2E_WEB_DIR
 * —— CI 上对装好的安装包跑这一遍,验证「Electron 当 Node 跑 → puppeteer-core 起浏览器」和安装包里带齐了 HyperFrames。
 */

const repo = fileURLToPath(new URL('..', import.meta.url));

test('聊一句做 10 秒开场动画 → 代码渲染出片,ffprobe 10 秒,联系表在作品目录', async ({ page }) => {
  test.setTimeout(1_200_000);
  const dataDir = process.env.VIDROOM_E2E_MOTION_DATA_DIR || join(repo, '.test-tmp', 'motion-e2e');
  const libraryDir = join(dataDir, 'library');
  rmSync(libraryDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const keyFile = join(dataDir, 'fake-key.txt');
  writeFileSync(keyFile, 'fake-deepseek-key-for-motion-e2e');

  const fake = await startFakeLlm();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VIDROOM_DATA_DIR: dataDir,
    VIDROOM_DEEPSEEK_KEY_FILE: keyFile,
    VIDROOM_DEEPSEEK_BASE_URL: fake.baseURL,
  };
  delete env.VIDROOM_LLM_PROVIDER;
  const electronExe = process.env.VIDROOM_E2E_ELECTRON;
  if (electronExe) {
    env.VIDROOM_HYPERFRAMES_DIR = process.env.VIDROOM_E2E_HYPERFRAMES_DIR ?? join(repo, 'apps', 'host', 'hyperframes');
    env.VIDROOM_WEB_DIR = process.env.VIDROOM_E2E_WEB_DIR ?? join(repo, 'apps', 'web', 'dist');
  }
  const host = await startHostProcess(
    env,
    electronExe ? { exe: electronExe, script: process.env.VIDROOM_E2E_HOST_SCRIPT ?? join(repo, 'apps', 'desktop', 'dist', 'host', 'host.mjs') } : undefined,
  );
  console.log(`[motion] Host 跑法:${electronExe ? `ELECTRON_RUN_AS_NODE=1 ${electronExe}` : 'node --import tsx'}`);
  try {
    await page.goto(host.launchUrl);
    await expect(page.getByLabel('输入消息')).toBeEnabled();
    const t0 = Date.now();
    await page.getByLabel('输入消息').fill('做一条10秒的开场动画,标题是VidRoom');
    await page.getByRole('button', { name: '发送' }).click();
    const answer = page.getByTestId('message-assistant').last().getByTestId('message-content');
    await expect(answer).toContainText('已用代码渲染了一条', { timeout: 1_100_000 });
    console.log(`[motion] 回答:${await answer.textContent()}(${((Date.now() - t0) / 1000).toFixed(1)} 秒)`);
    await expect(page.getByText('调用了工具:render_motion')).toBeVisible();

    // 入库记录:代码渲染、10 秒、分镜
    const lib = JSON.parse(readFileSync(join(libraryDir, 'videos.json'), 'utf8'));
    expect(lib).toHaveLength(1);
    const rec = lib[0];
    expect(rec).toMatchObject({ model: 'HyperFrames', prompt: MOTION_CALL.title, peakVramMiB: null, metricsSimulated: false });
    expect(rec.motion.shots.map((s: { label: string }) => s.label)).toEqual(['标题出现', '停留(背景持续运动)', '标题淡出']);

    // ffprobe 量时长:10 秒(用锁定的 LGPL ffprobe)
    const ff = await ensureFfmpeg({ root: dataDir });
    const probe = JSON.parse(
      execFileSync(ff.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height,r_frame_rate', '-of', 'json', rec.file], { encoding: 'utf8' }),
    );
    console.log(`[motion] ffprobe ${JSON.stringify(probe)}`);
    expect(Number(probe.format.duration)).toBeCloseTo(10, 1);
    expect(probe.streams[0]).toMatchObject({ codec_name: 'h264', width: 1280, height: 720, r_frame_rate: '30/1' });

    // 验收②:联系表 PNG 就在作品目录(和 MP4 同一个 library 目录)
    const sheet = join(libraryDir, `${rec.id}.contact.png`);
    expect(rec.contactSheet).toBe(sheet);
    expect(existsSync(sheet)).toBe(true);
    expect(readFileSync(sheet).subarray(1, 4).toString('ascii')).toBe('PNG');
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/motion-contact-sheet.png', readFileSync(sheet));

    // 作品库卡片与详情:标「代码渲染」,不写 AI 生成
    const card = page.getByTestId('video-card').first();
    await expect(card).toContainText('代码渲染');
    await card.click();
    const detail = page.getByTestId('video-detail');
    await expect(detail.getByTestId('code-render-note')).toBeVisible();
    await expect(detail).not.toContainText('AI-generated');
    await expect(detail.getByTestId('storyboard')).toContainText('标题出现');
    await page.screenshot({ path: 'test-results/motion-detail.png' });

    // 渲染的中间文件都清掉了(逐帧 PNG 不留)
    const work = join(dataDir, 'cache', 'motion');
    expect(existsSync(work) ? readdirSync(work) : []).toEqual([]);
  } finally {
    await host.stop();
    await fake.close();
  }
});
