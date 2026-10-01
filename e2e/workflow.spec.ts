import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { ensureFfmpeg, ffmpegBuildFor, ffmpegLayout } from '../apps/host/src/ffmpeg/install';
import { H3_LICENSE } from '../apps/host/src/h3/license';
import { H3_MODEL_FILES, type ModelFile } from '../apps/host/src/h3/models';
import { startFakeLlm } from './fake-llm';
import { startHostProcess } from './host';

const fakeComfyDir = fileURLToPath(new URL('../apps/host/test/fixtures/fake-comfyui', import.meta.url));
const VIDEO_VAE = H3_MODEL_FILES.find((f) => f.role === '视频 VAE')!;

interface Mirror {
  base: string;
  requests: string[];
  close: () => Promise<void>;
}

async function startMirror(files: Map<string, Buffer>): Promise<Mirror> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const data = files.get(req.url ?? '');
    if (!data) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-length': data.length }).end(data);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function fakeWeights(): Array<{ file: ModelFile; data: Buffer }> {
  return H3_MODEL_FILES.map((f, i) => {
    const data = randomBytes(32 * 1024 + i * 1000);
    return { file: { ...f, size: data.length, sha256: createHash('sha256').update(data).digest('hex') }, data };
  });
}

function testRoot(name: string): string {
  const dir = join(process.cwd(), '.test-tmp', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function seedFfmpeg(dataDir: string): Promise<void> {
  const cached = await ensureFfmpeg();
  const sourceInstallDir = dirname(dirname(dirname(cached.ffmpeg)));
  const target = ffmpegLayout(dataDir, ffmpegBuildFor(process.platform)).installDir;
  mkdirSync(dirname(target), { recursive: true });
  try {
    symlinkSync(sourceInstallDir, target, 'dir');
  } catch {
    cpSync(sourceInstallDir, target, { recursive: true });
  }
}

test('工作流库:默认工作流跑通,自定义工作流重启后可跑,可看 SKILL.md 原文', async ({ page }) => {
  test.setTimeout(240_000);
  const root = testRoot(`workflow-e2e-${Date.now()}`);
  const dataDir = join(root, 'data');
  const modelsDir = join(root, 'models');
  const weights = fakeWeights();
  const manifest = join(root, 'fake-manifest.json');
  writeFileSync(manifest, JSON.stringify(weights.map((w) => w.file)));
  const missing = weights.find((w) => w.file.role === '视频 VAE')!;
  for (const w of weights.filter((x) => x !== missing)) {
    mkdirSync(join(modelsDir, w.file.folder), { recursive: true });
    writeFileSync(join(modelsDir, w.file.folder, w.file.fileName), w.data);
  }
  const requestLog = join(root, 'prompt-requests.jsonl');
  const keyFile = join(root, 'fake-key.txt');
  writeFileSync(keyFile, 'fake-deepseek-key-for-workflow-e2e');

  await seedFfmpeg(dataDir);
  const mirror = await startMirror(new Map([[`/${missing.file.folder}/${missing.file.fileName}`, missing.data]]));
  const fake = await startFakeLlm();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VIDROOM_DATA_DIR: dataDir,
    VIDROOM_MODELS_DIR: modelsDir,
    VIDROOM_H3_DOWNLOAD_BASE: mirror.base,
    VIDROOM_H3_TEST_MANIFEST: manifest,
    VIDROOM_H3_EXPERIMENTAL: '1',
    VIDROOM_COMFYUI_DIR: fakeComfyDir,
    VIDROOM_COMFYUI_PYTHON: process.env.VIDROOM_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
    VIDROOM_COMFYUI_ARGS: `--output-directory ${join(root, 'comfy-out')}`,
    VIDROOM_DEEPSEEK_KEY_FILE: keyFile,
    VIDROOM_DEEPSEEK_BASE_URL: fake.baseURL,
    FAKE_COMFY_REQUEST_LOG: requestLog,
    FAKE_COMFY_STEP_MS: '80',
  };
  let host = await startHostProcess(env);
  try {
    await page.goto(host.launchUrl);
    await expect(page.getByLabel('输入消息')).toBeEnabled();

    const panel = page.getByTestId('h3-panel');
    await panel.getByRole('button', { name: '出片' }).click();
    const dialog = page.getByTestId('license-dialog');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: '同意并下载' }).click();
    await expect(panel.getByTestId('h3-download')).toHaveText(`下载完成:vae/${VIDEO_VAE.fileName}`, { timeout: 60_000 });
    expect(JSON.parse(readFileSync(join(dataDir, 'h3-consent.json'), 'utf8')).licenseSha256).toBe(H3_LICENSE.sha256);

    const workflows = page.getByTestId('workflow-library');
    await expect(workflows).toContainText('默认工作流');
    await workflows.getByLabel('工作流主题').fill('橘猫在夜晚的书桌上拍短片');
    await workflows.getByTestId('workflow-topic-to-video').getByRole('button', { name: '运行' }).click();
    await expect(page.getByTestId('workflow-job')).toContainText('完成', { timeout: 120_000 });

    let sent = readFileSync(requestLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(sent).toHaveLength(3);
    expect(sent.map((s) => s.prompt['140:131'].inputs.length)).toEqual([73, 73, 73]);
    let lib = JSON.parse(readFileSync(join(dataDir, 'library', 'videos.json'), 'utf8'));
    expect(lib[0].editedFrom).toMatchObject({ op: 'subtitle' });
    expect(lib[1].editedFrom).toMatchObject({ op: 'concat', sources: expect.arrayContaining([expect.stringMatching(/^\d/), expect.stringMatching(/^\d/), expect.stringMatching(/^\d/)]) });
    expect(existsSync(lib[0].file)).toBe(true);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', lib[0].file], { encoding: 'utf8' }));
    expect(Number(probe.format.duration)).toBeGreaterThan(0);

    await page.getByLabel('输入消息').fill('以后都这么做');
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.getByTestId('message-assistant').last()).toContainText('已保存', { timeout: 30_000 });
    await expect.poll(() => existsSync(join(dataDir, 'workflows', 'custom-topic-video', 'SKILL.md'))).toBe(true);

    await host.stop();
    host = await startHostProcess(env);
    await page.goto(host.launchUrl);
    const custom = page.getByTestId('workflow-custom-topic-video');
    await expect(custom).toContainText('自定义主题成片');
    await custom.getByRole('button', { name: '看原文' }).click();
    await expect(page.getByLabel('SKILL.md 原文')).toContainText('name: custom-topic-video');
    await expect(page.getByLabel('SKILL.md 原文')).toContainText('```workflow');
    await page.getByLabel('工作流主题').fill('橘猫重启后再次出片');
    await custom.getByRole('button', { name: '运行' }).click();
    await expect(page.getByTestId('workflow-job')).toContainText('完成', { timeout: 120_000 });

    sent = readFileSync(requestLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(sent.map((s) => s.prompt['140:131'].inputs.length)).toEqual([73, 73, 73, 73, 73, 73]);
    lib = JSON.parse(readFileSync(join(dataDir, 'library', 'videos.json'), 'utf8'));
    expect(lib[0].editedFrom).toMatchObject({ op: 'subtitle' });
  } finally {
    await host?.stop();
    await fake.close();
    await mirror.close();
  }
});
