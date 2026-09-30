import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  H3_DOWNLOAD_BASE_ENV,
  H3_MODEL_FILES,
  HF_REPO,
  HF_REVISION,
  ModelStore,
  modelUrl,
  writeExtraModelPaths,
  type ModelFile,
} from '../src/h3/models.js';

interface HfEntry {
  type: string;
  path: string;
  size: number;
  lfs?: { oid: string; size: number };
}

const hfTree = JSON.parse(
  readFileSync(new URL('./fixtures/hf-comfy-org-minimax-h3-tree.json', import.meta.url), 'utf8'),
) as HfEntry[];

describe('H3 权重清单', () => {
  it('四个文件的 size 与 sha256 和 Hugging Face API 返回的 lfs 字段逐项一致', () => {
    expect(H3_MODEL_FILES).toHaveLength(4);
    for (const f of H3_MODEL_FILES) {
      const entry = hfTree.find((e) => e.path === `${f.folder}/${f.fileName}`);
      expect(entry, `${f.folder}/${f.fileName} 不在 HF 文件树里`).toBeDefined();
      expect(entry!.lfs!.size).toBe(f.size);
      expect(entry!.size).toBe(f.size);
      expect(entry!.lfs!.oid).toBe(f.sha256);
    }
  });

  it('下载地址钉在 commit 上;设了镜像前缀就用镜像', () => {
    const vae = H3_MODEL_FILES.find((f) => f.role === '视频 VAE')!;
    expect(modelUrl(vae, {})).toBe(
      `https://huggingface.co/${HF_REPO}/resolve/${HF_REVISION}/vae/minimax_h3_video_vae_int8_convrot.safetensors`,
    );
    expect(modelUrl(vae, { [H3_DOWNLOAD_BASE_ENV]: 'http://127.0.0.1:9/m/' })).toBe(
      'http://127.0.0.1:9/m/vae/minimax_h3_video_vae_int8_convrot.safetensors',
    );
  });

  it('extra_model_paths.yaml 指向模型目录,单引号转义', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vidroom-emp-'));
    const cfg = join(dir, 'extra.yaml');
    await writeExtraModelPaths(cfg, "C:\\Users\\o'neil\\models");
    const yaml = readFileSync(cfg, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    expect(yaml).toContain("base_path: 'C:\\Users\\o''neil\\models'");
    expect(yaml).toContain("diffusion_models: 'diffusion_models'");
    expect(yaml).toContain("text_encoders: 'text_encoders'");
    expect(yaml).toContain("vae: 'vae'");
  });
});

// 小文件模拟四个权重:三个本地已有,一个(视频 VAE)缺
function fakeFile(folder: ModelFile['folder'], fileName: string, role: string) {
  const data = randomBytes(64 * 1024 + fileName.length);
  const file: ModelFile = { folder, fileName, role, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  return { file, data };
}

describe('ModelStore', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });

  it('已有且 sha256 对得上的跳过,只下缺的;对不上的判 mismatch 并重下', async () => {
    const parts = [
      fakeFile('diffusion_models', 'dit.safetensors', '扩散主干'),
      fakeFile('text_encoders', 'te.safetensors', '文本编码器'),
      fakeFile('vae', 'video_vae.safetensors', '视频 VAE'),
      fakeFile('vae', 'audio_vae.safetensors', '音频 VAE'),
    ];
    const dir = mkdtempSync(join(tmpdir(), 'vidroom-models-'));
    for (const p of [parts[0], parts[1], parts[3]]) {
      mkdirSync(join(dir, p.file.folder), { recursive: true });
      writeFileSync(join(dir, p.file.folder, p.file.fileName), p.data);
    }
    const requested: string[] = [];
    server = createServer((req, res) => {
      requested.push(req.url ?? '');
      const hit = parts.find((p) => req.url === `/${p.file.folder}/${p.file.fileName}`);
      if (!hit) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-length': hit.data.length }).end(hit.data);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const store = new ModelStore(dir, join(dir, '.sha-cache.json'), parts.map((p) => p.file));
    expect((await store.inspect()).map((s) => s.state)).toEqual(['ok', 'ok', 'missing', 'ok']);

    const got = await store.downloadMissing({ env: { [H3_DOWNLOAD_BASE_ENV]: base } });
    expect(got.map((f) => f.fileName)).toEqual(['video_vae.safetensors']);
    expect(requested).toEqual(['/vae/video_vae.safetensors']);
    expect((await store.inspect()).every((s) => s.state === 'ok')).toBe(true);

    // 缓存命中:第二次 inspect 不重算(改坏内容但保持大小和 mtime 不变的情况这里不测,只测缓存文件存在)
    expect(Object.keys(JSON.parse(readFileSync(join(dir, '.sha-cache.json'), 'utf8')))).toHaveLength(4);

    // 同大小但内容不对 → mismatch → 重下
    const bad = Buffer.from(parts[1].data);
    bad[0] ^= 0xff;
    writeFileSync(join(dir, 'text_encoders', 'te.safetensors'), bad);
    const st = await store.inspect();
    expect(st.map((s) => s.state)).toEqual(['ok', 'mismatch', 'ok', 'ok']);
    requested.length = 0;
    await store.downloadMissing({ env: { [H3_DOWNLOAD_BASE_ENV]: base } });
    expect(requested).toEqual(['/text_encoders/te.safetensors']);
    rmSync(dir, { recursive: true, force: true });
  });
});
