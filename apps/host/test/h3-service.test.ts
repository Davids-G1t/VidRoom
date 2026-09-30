import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ComfyManager } from '../src/comfyui/manager.js';
import { resultFromOutput, type GpuTier } from '../src/gpu.js';
import { H3_EXPERIMENTAL_ENV, h3Admission } from '../src/h3/admission.js';
import { ConsentStore, H3_LICENSE } from '../src/h3/license.js';
import { VideoLibrary } from '../src/h3/library.js';
import { ModelStore, type ModelFile } from '../src/h3/models.js';
import { VideoService, checkPrompt, countWords } from '../src/h3/service.js';
import { CAT_PROMPT } from './fixtures/h3-prompts.js';

/**
 * 出片服务 + 假 ComfyUI 回放(fixtures/fake-comfyui:Python 标准库 + ffmpeg testsrc 占位)。
 * 需要 PATH 上有 Python 和 ffmpeg/ffprobe;不加载任何模型。
 */

const fakeDir = fileURLToPath(new URL('./fixtures/fake-comfyui', import.meta.url));
const python = process.env.VIDROOM_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');



function smallModels(dir: string): ModelFile[] {
  const files: ModelFile[] = [];
  for (const [folder, name, role] of [
    ['diffusion_models', 'dit.safetensors', '扩散主干'],
    ['text_encoders', 'te.safetensors', '文本编码器'],
    ['vae', 'video_vae.safetensors', '视频 VAE'],
    ['vae', 'audio_vae.safetensors', '音频 VAE'],
  ] as const) {
    const data = Buffer.from(`fake ${name}`);
    mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, folder, name), data);
    files.push({ folder, fileName: name, role, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }
  return files;
}

describe('提示词检查', () => {
  it('示例提示词在 180–260 词之间', () => {
    const n = countWords(CAT_PROMPT);
    expect(n).toBeGreaterThanOrEqual(180);
    expect(n).toBeLessThanOrEqual(260);
    expect(checkPrompt(CAT_PROMPT)).toBeNull();
  });
  it('太短、太长、含中文都退回', () => {
    expect(checkPrompt('a cat on a windowsill')).toMatch(/要求 180–260/);
    expect(checkPrompt(`${CAT_PROMPT} ${CAT_PROMPT}`)).toMatch(/要求 180–260/);
    expect(checkPrompt(`${CAT_PROMPT} 橘猫`)).toMatch(/英文/);
  });
});

describe('准入分档', () => {
  it('default 允许;experimental 默认不允许、开关打开才允许;unsupported/none 不允许', () => {
    expect(h3Admission('default', {}).allowed).toBe(true);
    expect(h3Admission('experimental', {}).allowed).toBe(false);
    expect(h3Admission('experimental', {}).reason).toContain(H3_EXPERIMENTAL_ENV);
    expect(h3Admission('experimental', { [H3_EXPERIMENTAL_ENV]: '1' }).allowed).toBe(true);
    expect(h3Admission('experimental', { [H3_EXPERIMENTAL_ENV]: 'true' }).allowed).toBe(false);
    expect(h3Admission('unsupported', { [H3_EXPERIMENTAL_ENV]: '1' }).allowed).toBe(false);
    expect(h3Admission('none', { [H3_EXPERIMENTAL_ENV]: '1' }).allowed).toBe(false);
  });
});

describe('许可原文', () => {
  it('随聊天页分发的许可文件 sha256 与代码里记的一致;NOTICE 文件是原文', () => {
    const lic = readFileSync(fileURLToPath(new URL('../../web/public/licenses/MiniMax-H3-LICENSE.txt', import.meta.url)));
    expect(createHash('sha256').update(lic).digest('hex')).toBe(H3_LICENSE.sha256);
    const notice = readFileSync(fileURLToPath(new URL('../../web/public/licenses/MiniMax-H3-NOTICE.txt', import.meta.url)), 'utf8');
    expect(notice.trim()).toBe(
      'MiniMax H3 is licensed under the MiniMax H3 Community License Agreement, Copyright © 2026 MiniMax. All Rights Reserved.',
    );
  });
});

describe('VideoService(假 ComfyUI 回放)', () => {
  const root = mkdtempSync(join(tmpdir(), 'vidroom-h3svc-'));
  const requestLog = join(root, 'prompt-requests.jsonl');
  const modelsDir = join(root, 'models');
  const files = smallModels(modelsDir);
  const comfy = new ComfyManager({
    resolveInstall: async () => ({ comfyDir: fakeDir, python, source: 'local' }),
    extraArgs: ['--output-directory', join(root, 'comfy-out')],
    log: () => {},
  });
  const consent = new ConsentStore(join(root, 'h3-consent.json'));
  const library = new VideoLibrary(join(root, 'library'));
  let tier: GpuTier = 'default';
  const env: NodeJS.ProcessEnv = {};
  const svc = new VideoService({
    comfy,
    models: new ModelStore(modelsDir, join(root, 'sha-cache.json'), files),
    consent,
    library,
    probeGpu: async () => ({ ...resultFromOutput(null), tier }),
    env,
    log: () => {},
    sampleMs: 100,
  });
  const prompts = () => (existsSync(requestLog) ? readFileSync(requestLog, 'utf8').trim().split('\n').filter(Boolean) : []);

  beforeAll(() => {
    process.env.FAKE_COMFY_REQUEST_LOG = requestLog;
    process.env.FAKE_COMFY_STEP_MS = '100';
  });
  afterAll(async () => {
    await comfy.stop();
    rmSync(root, { recursive: true, force: true });
    delete process.env.FAKE_COMFY_REQUEST_LOG;
    delete process.env.FAKE_COMFY_STEP_MS;
  });

  it('没同意许可:拒绝出片,/prompt 没被调用;下载也被拒', async () => {
    const r = await svc.generate({ prompt: CAT_PROMPT, seconds: 5 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('许可');
    await expect(svc.startDownload()).rejects.toThrow('许可');
    expect(prompts()).toHaveLength(0);
  });

  it('experimental 档默认拒绝,/prompt 没被调用', async () => {
    await consent.accept(H3_LICENSE.sha256);
    tier = 'experimental';
    const r = await svc.generate({ prompt: CAT_PROMPT, seconds: 5 });
    expect(!r.ok && r.reason).toContain(H3_EXPERIMENTAL_ENV);
    expect(prompts()).toHaveLength(0);
  });

  it('开关打开后出片:5 秒 → 124 帧的锁定模板请求,进度转发,成片入库,MP4 带 AI 生成标注', async () => {
    env[H3_EXPERIMENTAL_ENV] = '1';
    const seen: string[] = [];
    const poll = setInterval(() => {
      const j = svc.job();
      if (j.state === 'running' && j.max > 0) seen.push(`${j.value}/${j.max}`);
    }, 20);
    const r = await svc.generate({ prompt: CAT_PROMPT, seconds: 5 });
    clearInterval(poll);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.at(-1)).toBe('20/20');

    const sent = prompts().map((l) => JSON.parse(l));
    expect(sent).toHaveLength(1);
    const i2v = Object.values(sent[0].prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>).find(
      (n) => n.class_type === 'MiniMaxH3ImageToVideo',
    )!;
    expect(i2v.inputs.length).toBe(124);
    expect(i2v.inputs.prompt).toBe(CAT_PROMPT);
    expect(sent[0].extra_data.extra_pnginfo.comment).toBe('AI-generated with MiniMax H3');

    expect(r.video).toMatchObject({ model: 'MiniMax H3', frames: 124, prompt: CAT_PROMPT, metricsSimulated: true });
    expect(r.video.peakVramMiB).toBeGreaterThan(0);
    expect(r.video.peakRamMiB).toBeGreaterThan(0);
    expect(r.video.elapsedMs).toBeGreaterThan(0);
    const [rec] = await library.list();
    expect(rec.id).toBe(r.video.id);
    expect(existsSync(rec.file)).toBe(true);

    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream=nb_frames,width,height', '-of', 'json', rec.file], {
        encoding: 'utf8',
      }),
    );
    expect(probe.format.tags.comment).toContain('AI-generated with MiniMax H3');
    expect(Number(probe.streams[0].nb_frames)).toBe(124);
    expect([probe.streams[0].width, probe.streams[0].height]).toEqual([864, 480]);
    expect(svc.job()).toEqual({ state: 'done', videoId: rec.id });
  }, 60_000);

  it('提示词不合格:不提交', async () => {
    const before = prompts().length;
    const r = await svc.generate({ prompt: 'a cat', seconds: 3 });
    expect(r.ok).toBe(false);
    expect(prompts()).toHaveLength(before);
  });

  it('出片中取消:任务停下、ComfyUI 被停掉', async () => {
    const running = svc.generate({ prompt: CAT_PROMPT, seconds: 3 });
    while (svc.job().state !== 'running') await new Promise((r) => setTimeout(r, 20));
    expect(svc.busy).toBe(true);
    await svc.cancel();
    const r = await running;
    expect(r.ok).toBe(false);
    expect(svc.job().state).toBe('cancelled');
    expect(comfy.status().state).toBe('stopped');
    const last = JSON.parse(prompts().at(-1)!);
    const i2v = Object.values(last.prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>).find(
      (n) => n.class_type === 'MiniMaxH3ImageToVideo',
    )!;
    expect(i2v.inputs.length).toBe(73);
  }, 60_000);
});
