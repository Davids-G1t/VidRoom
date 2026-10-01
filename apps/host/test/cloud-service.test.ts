import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CloudService } from '../src/cloud/service.js';
import { CLOUD_KEY_FILE_ENVS } from '../src/cloud/providers.js';
import { VideoLibrary } from '../src/h3/library.js';

const dir = mkdtempSync(join(tmpdir(), 'vidroom-cloud-svc-'));

function service(env: NodeJS.ProcessEnv = {}, keyFor?: 'video' | 'image'): CloudService {
  const dataDir = mkdtempSync(join(dir, 'data-'));
  const library = new VideoLibrary(join(dataDir, 'library'));
  return new CloudService({ dataDir, library, env, log: () => {} });
}

function serviceWithKey(kind: 'video' | 'image', key = 'sk-fake'): CloudService {
  const file = join(mkdtempSync(join(dir, 'key-')), `${kind}.txt`);
  writeFileSync(file, key);
  return service({ [CLOUD_KEY_FILE_ENVS[kind]]: file });
}

describe('CloudService 的估价(不发请求、不花钱)', () => {
  it('估价返回原样参数,确认方拿它去发起同一件事', () => {
    const cloud = service();
    const est = cloud.estimateVideo({ prompt: ' 一只橘猫 ', seconds: 5, resolution: '1080p' });
    expect(est).toMatchObject({ kind: 'video', provider: '通义万相(阿里云百炼)', model: 'wan2.7-t2v', estimateCents: 500 });
    expect(est.request).toEqual({ kind: 'video', prompt: '一只橘猫', seconds: 5, resolution: '1080p' });
    expect(est.estimateText).toContain('¥5.00');
  });

  it('没给时长/清晰度就用默认(5 秒 720p)', () => {
    const est = service().estimateVideo({ prompt: '猫' });
    expect(est.estimateCents).toBe(300);
    expect(est.request).toEqual({ kind: 'video', prompt: '猫', seconds: 5, resolution: '720p' });
  });

  it('生图估价就是一张的价,张数这个活口已去掉(付了钱丢图的坑)', () => {
    const est = service().estimateImage({ prompt: '猫' });
    expect(est.estimateCents).toBe(22);
    expect(est.request).toEqual({ kind: 'image', prompt: '猫' });
  });

  it('参数不合格当场报错,不落到「发请求才发现」', () => {
    const cloud = service();
    expect(() => cloud.estimateVideo({ prompt: '   ' })).toThrow('提示词');
    expect(() => cloud.estimateVideo({ prompt: '猫', seconds: 1 })).toThrow('2–15');
    expect(() => cloud.estimateVideo({ prompt: '猫', seconds: 16 })).toThrow('2–15');
    expect(() => cloud.estimateVideo({ prompt: '猫', seconds: 5.5 })).toThrow('整数秒');
    expect(() => cloud.estimateVideo({ prompt: '猫', resolution: '4k' as never })).toThrow('720p');
    expect(() => cloud.estimateImage({ prompt: '   ' })).toThrow('提示词');
  });
});

describe('CloudService 的 key 与状态', () => {
  it('没配 key 时状态是未配置,generate 直接给原因、不发请求', async () => {
    const cloud = service();
    expect(cloud.status().providers.map((p) => p.configured)).toEqual([false, false]);
    expect(cloud.configuredKeys()).toEqual([]);
    await expect(cloud.generateVideo({ prompt: '猫', seconds: 5 })).resolves.toEqual({
      ok: false,
      reason: '还没配置通义万相(阿里云百炼)的 API key,去设置里填。',
    });
    await expect(cloud.generateImage({ prompt: '猫' })).resolves.toEqual({
      ok: false,
      reason: '还没配置Seedream(火山方舟)的 API key,去设置里填。',
    });
  });

  it('setKeys 之后状态变了,配置过的 key 才进「要抹掉的秘密」名单', () => {
    const cloud = service();
    cloud.setKeys({ video: 'sk-a' });
    expect(cloud.status().providers.map((p) => p.configured)).toEqual([true, false]);
    expect(cloud.configuredKeys()).toEqual(['sk-a']);
    cloud.setKeys({ image: 'sk-b' });
    expect(cloud.configuredKeys()).toEqual(['sk-a', 'sk-b']);
    cloud.setKeys({ video: null });
    expect(cloud.status().providers.map((p) => p.configured)).toEqual([false, true]);
    expect(cloud.configuredKeys()).toEqual(['sk-b']);
  });

  it('命令行开发:环境变量指的 key 文件在启动时就生效', () => {
    expect(serviceWithKey('image').status().providers.map((p) => p.configured)).toEqual([false, true]);
  });
});

describe('生图产物的路径', () => {
  it('只认纯 id,带路径的 id 一律拒绝', async () => {
    const dataDir = mkdtempSync(join(dir, 'data-'));
    const cloud = new CloudService({ dataDir, library: new VideoLibrary(join(dataDir, 'library')), log: () => {} });
    expect(cloud.imagePath('20261002T101010-ab12cd34')).toBe(join(dataDir, 'images', '20261002T101010-ab12cd34.png'));
    expect(cloud.imagePath('../etc/passwd')).toBeNull();
    expect(cloud.imagePath('a/b')).toBeNull();
    // 目录不存在时也不报错(server 那边用 stat 判 404)
    mkdirSync(join(dataDir, 'images'), { recursive: true });
    expect(cloud.imagePath('x')).not.toBeNull();
  });
});
