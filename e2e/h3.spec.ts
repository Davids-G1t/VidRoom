import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CAT_PROMPT } from '../apps/host/test/fixtures/h3-prompts';
import { H3_LICENSE, H3_NOTICE } from '../apps/host/src/h3/license';
import { H3_MODEL_FILES } from '../apps/host/src/h3/models';
import { buildH3Prompt } from '../apps/host/src/h3/workflow';
import { startFakeLlm } from './fake-llm';
import { startHostProcess } from './host';

/**
 * 开发机专用:MiniMax H3 出片全链路,**假 ComfyUI 回放**(不加载模型、不占显卡)+ 假 LLM + 本机假「HF 镜像」。
 *
 * 前提(不满足直接失败,不跳过):
 * - VIDROOM_E2E_H3_MODELS_DIR 指向一个已有四个 H3 权重(完整、sha256 对得上)的目录:
 *   测试把其中扩散主干、文本编码器、音频 VAE 三个文件软链进临时模型目录(应被识别为「已有,跳过」),
 *   视频 VAE 由假镜像从这个目录读出来发给 Host(模拟「从 HF 下载缺的那个文件」,记录每一个下载请求)。
 * - 本机显卡在 experimental 或 default 档(experimental 档由测试设 VIDROOM_H3_EXPERIMENTAL=1 打开)。
 * - PATH 上有 Python、ffmpeg、ffprobe。
 *
 * 覆盖验收:① 端到端(假回放)、⑤ 成片卡片/详情/「关于」页标名与 NOTICE、⑥ 许可页与下载、⑧「举报滥用」入口。
 */

const fakeComfyDir = fileURLToPath(new URL('../apps/host/test/fixtures/fake-comfyui', import.meta.url));
const ABUSE_URL = 'https://github.com/Davids-G1t/VidRoom/issues/new?template=abuse-report.yml';
const VIDEO_VAE = H3_MODEL_FILES.find((f) => f.role === '视频 VAE')!;

interface Mirror {
  base: string;
  requests: string[];
  close: () => Promise<void>;
}

/** 假 HF:按 /<folder>/<fileName> 从真实模型目录读文件发出去,记下每个请求 */
async function startMirror(sourceDir: string): Promise<Mirror> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const f = H3_MODEL_FILES.find((m) => req.url === `/${m.folder}/${m.fileName}`);
    const path = f && join(sourceDir, f.folder, f.fileName);
    if (!path || !existsSync(path)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-length': statSync(path).size });
    createReadStream(path).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

test('出片:许可页 → 只下缺的视频 VAE → 聊一句出片(假回放)→ 作品库与「关于」标名 → 举报滥用', async ({ page }) => {
  test.setTimeout(2_400_000); // 核对 37 GB 权重 + 本机传 2.8 GB,机器忙时要很久
  const source = process.env.VIDROOM_E2E_H3_MODELS_DIR;
  expect(source, '需要设置 VIDROOM_E2E_H3_MODELS_DIR(已有完整 H3 权重的目录)').toBeTruthy();
  for (const f of H3_MODEL_FILES) {
    const p = join(source!, f.folder, f.fileName);
    expect(existsSync(p) && statSync(p).size === f.size, `${p} 不存在或大小不对`).toBe(true);
  }

  const root = mkdtempSync(join(tmpdir(), 'vidroom-e2e-h3-'));
  const dataDir = join(root, 'data');
  const modelsDir = join(root, 'models');
  for (const f of H3_MODEL_FILES.filter((m) => m !== VIDEO_VAE)) {
    mkdirSync(join(modelsDir, f.folder), { recursive: true });
    symlinkSync(join(source!, f.folder, f.fileName), join(modelsDir, f.folder, f.fileName));
  }
  const requestLog = join(root, 'prompt-requests.jsonl');
  const keyFile = join(root, 'fake-key.txt');
  writeFileSync(keyFile, 'fake-deepseek-key-for-h3-e2e');

  const mirror = await startMirror(source!);
  const fake = await startFakeLlm();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VIDROOM_DATA_DIR: dataDir,
    VIDROOM_MODELS_DIR: modelsDir,
    VIDROOM_H3_DOWNLOAD_BASE: mirror.base,
    VIDROOM_H3_EXPERIMENTAL: '1',
    VIDROOM_COMFYUI_DIR: fakeComfyDir,
    VIDROOM_COMFYUI_PYTHON: process.env.VIDROOM_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
    VIDROOM_COMFYUI_ARGS: `--output-directory ${join(root, 'comfy-out')}`,
    VIDROOM_DEEPSEEK_KEY_FILE: keyFile,
    VIDROOM_DEEPSEEK_BASE_URL: fake.baseURL,
    FAKE_COMFY_REQUEST_LOG: requestLog,
    FAKE_COMFY_STEP_MS: '400',
  };
  const host = await startHostProcess(env);
  const consentFile = join(dataDir, 'h3-consent.json');
  const prompts = () => (existsSync(requestLog) ? readFileSync(requestLog, 'utf8').trim().split('\n').filter(Boolean) : []);

  try {
    await page.goto(host.launchUrl);
    await expect(page.getByLabel('输入消息')).toBeEnabled();

    // ---------- ⑤「关于」页:MiniMax H3 标名 + NOTICE 原文 ----------
    await page.getByRole('button', { name: '关于' }).click();
    const about = page.getByTestId('about');
    await expect(about).toContainText('MiniMax H3');
    await expect(about.getByTestId('h3-notice')).toHaveText(H3_NOTICE);
    await page.screenshot({ path: 'test-results/h3-about.png' });

    // ---------- ⑧「举报滥用」打开 issue 模板(不真去 GitHub:拦下请求,只看地址) ----------
    await page.context().route('https://github.com/**', (r) => r.fulfill({ status: 200, body: 'ok' }));
    const [popup] = await Promise.all([page.waitForEvent('popup'), about.getByRole('button', { name: '举报滥用' }).click()]);
    expect(popup.url()).toBe(ABUSE_URL);
    await popup.close();
    await about.getByRole('button', { name: '关闭' }).click();
    const [popup2] = await Promise.all([page.waitForEvent('popup'), page.getByLabel('菜单').getByRole('button', { name: '举报滥用' }).click()]);
    expect(popup2.url()).toBe(ABUSE_URL);
    await popup2.close();

    // ---------- ⑥ 第一次点「出片」:许可页;不勾就关 → 一个下载请求都没有,没有同意记录 ----------
    const panel = page.getByTestId('h3-panel');
    await panel.getByRole('button', { name: '出片' }).click();
    const dialog = page.getByTestId('license-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('license-text')).toContainText('MiniMax H3 COMMUNITY LICENSE AGREEMENT');
    await expect(dialog.getByTestId('license-text')).toContainText('Exhibit A — Acceptable Use Policy');
    await expect(dialog.getByTestId('license-summary')).toContainText('欧盟、英国、韩国、美国');
    await expect(dialog.getByTestId('license-summary')).toContainText('不许拿生成的内容训练或改进别的 AI 模型');
    await expect(dialog.getByRole('button', { name: '同意并下载' })).toBeDisabled();
    await page.screenshot({ path: 'test-results/h3-license.png' });
    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(1_500);
    expect(mirror.requests).toEqual([]);
    expect(existsSync(consentFile)).toBe(false);

    // 没同意时直接调下载接口也被拒
    const denied = await page.request.post(`${host.origin}/api/h3/download`);
    expect(denied.status()).toBe(403);
    expect(mirror.requests).toEqual([]);

    // ---------- ⑥ 勾选同意 → 只下缺的视频 VAE;已有三个文件跳过;有同意记录 ----------
    await panel.getByRole('button', { name: '出片' }).click();
    await dialog.getByRole('checkbox').check();
    const t0 = Date.now();
    await dialog.getByRole('button', { name: '同意并下载' }).click();
    await expect(panel.getByTestId('h3-download')).toHaveText(`下载完成:vae/${VIDEO_VAE.fileName}`, { timeout: 1_500_000 });
    console.log(`[h3] 核对 + 下载用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒,镜像收到的请求:${JSON.stringify(mirror.requests)}`);
    expect(mirror.requests).toEqual([`/vae/${VIDEO_VAE.fileName}`]);
    const consent = JSON.parse(readFileSync(consentFile, 'utf8'));
    expect(consent.licenseSha256).toBe(H3_LICENSE.sha256);
    expect(Date.now() - Date.parse(consent.acceptedAt)).toBeLessThan(600_000);
    console.log(`[h3] 同意记录 ${JSON.stringify(consent)}`);
    const st = await (await page.request.get(`${host.origin}/api/h3?models=1`)).json();
    expect(st.models.map((m: { state: string }) => m.state)).toEqual(['ok', 'ok', 'ok', 'ok']);
    await expect(panel.getByTestId('h3-consent')).toBeVisible();

    // ---------- ① 聊一句 → generate_video → 锁定模板的 /prompt → 假回放 → 入库 ----------
    await page.getByLabel('输入消息').fill('一只橘猫在窗台上晒太阳,镜头慢慢推近');
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.getByTestId('pending')).toContainText(/MiniMax H3 正在生成视频:第 \d+ \/ 20 步/, { timeout: 60_000 });
    await page.screenshot({ path: 'test-results/h3-progress.png' });
    const answer = page.getByTestId('message-assistant').last().getByTestId('message-content');
    await expect(answer).toContainText('已用 MiniMax H3 生成', { timeout: 120_000 });
    console.log(`[h3] 回答:${await answer.textContent()}`);

    const sent = prompts().map((l) => JSON.parse(l));
    expect(sent).toHaveLength(1);
    const seed = sent[0].prompt['140:129'].inputs.noise_seed;
    // 除了种子(每次随机)之外,和锁定官方模板按「提示词 + 124 帧」生成的 API JSON 完全一致
    expect(sent[0].prompt).toEqual(buildH3Prompt({ prompt: CAT_PROMPT, frames: 124, seed }));
    expect(sent[0].prompt['140:131'].inputs.length % 17).toBe(5);
    expect(sent[0].extra_data.extra_pnginfo.comment).toBe('AI-generated with MiniMax H3');

    // 入库记录与文件
    const lib = JSON.parse(readFileSync(join(dataDir, 'library', 'videos.json'), 'utf8'));
    expect(lib).toHaveLength(1);
    expect(lib[0]).toMatchObject({ model: 'MiniMax H3', prompt: CAT_PROMPT, frames: 124, metricsSimulated: true });
    for (const k of ['elapsedMs', 'peakVramMiB', 'peakRamMiB']) expect(lib[0][k]).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(lib[0].createdAt))).toBe(false);
    const tags = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', lib[0].file], { encoding: 'utf8' }),
    ).format.tags;
    console.log(`[h3] 成片 ffprobe 元数据 ${JSON.stringify(tags)}`);
    expect(tags.comment).toContain('AI-generated with MiniMax H3');

    // ---------- ⑤ 成片卡片与详情页都标「MiniMax H3」 ----------
    const card = page.getByTestId('video-card').first();
    await expect(card).toContainText('MiniMax H3');
    await card.click();
    const detail = page.getByTestId('video-detail');
    await expect(detail).toContainText('MiniMax H3');
    await expect(detail.getByTestId('simulated-note')).toBeVisible();
    const playable = await detail.getByTestId('video-player').evaluate(
      (v: HTMLVideoElement) =>
        new Promise<number>((resolve) => {
          if (v.readyState >= 1) return resolve(v.duration);
          v.addEventListener('loadedmetadata', () => resolve(v.duration), { once: true });
          v.addEventListener('error', () => resolve(-1), { once: true });
        }),
    );
    console.log(`[h3] 页面播放器读到时长 ${playable} 秒`);
    expect(playable).toBeCloseTo(124 / 24, 1);
    await page.screenshot({ path: 'test-results/h3-detail.png' });
  } finally {
    await host.stop();
    await fake.close();
    await mirror.close();
  }
});
