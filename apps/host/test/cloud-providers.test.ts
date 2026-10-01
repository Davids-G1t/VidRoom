import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLOUD_BASE_URL_ENVS,
  CLOUD_DOMESTIC_BASE_URLS,
  CLOUD_KEY_FILE_ENVS,
  CLOUD_PROVIDERS,
  cloudBaseUrl,
  createCloudImageModel,
  createCloudVideoModel,
  loadCloudKey,
} from '../src/cloud/providers.js';

const dir = mkdtempSync(join(tmpdir(), 'vidroom-cloud-'));

describe('云端 key 的读法(与本地 LLM 那套同规矩)', () => {
  it('环境变量指向的文件里有 key 就读它,首尾空白去掉', () => {
    const file = join(dir, 'video-key.txt');
    writeFileSync(file, ' sk-cloud-1 \n');
    expect(loadCloudKey('video', { [CLOUD_KEY_FILE_ENVS.video]: file })).toBe('sk-cloud-1');
  });

  it('没设变量、文件不存在、文件是空的,一律当成没配置', () => {
    const empty = join(dir, 'empty-key.txt');
    writeFileSync(empty, '\n  \n');
    expect(loadCloudKey('video', {})).toBeNull();
    expect(loadCloudKey('image', { [CLOUD_KEY_FILE_ENVS.image]: join(dir, 'nope.txt') })).toBeNull();
    expect(loadCloudKey('image', { [CLOUD_KEY_FILE_ENVS.image]: empty })).toBeNull();
  });

  it('两家的变量名各是一个,与 key.ts 一家一个变量同形', () => {
    expect(CLOUD_KEY_FILE_ENVS).toEqual({
      video: 'VIDROOM_CLOUD_VIDEO_KEY_FILE',
      image: 'VIDROOM_CLOUD_IMAGE_KEY_FILE',
    });
  });
});

describe('baseURL', () => {
  it('默认走国内站;测试可用环境变量指到别处', () => {
    expect(cloudBaseUrl('video', {})).toBe(CLOUD_DOMESTIC_BASE_URLS.video);
    expect(cloudBaseUrl('image', {})).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(cloudBaseUrl('video', { [CLOUD_BASE_URL_ENVS.video]: ' http://127.0.0.1:1234 ' })).toBe('http://127.0.0.1:1234');
  });
});

describe('模型工厂', () => {
  it('造出来的是模型对象(不是模型 id 字符串),且模型 id 与官网一致;不发任何请求', () => {
    const video = createCloudVideoModel('sk-x', 'https://example.invalid');
    const image = createCloudImageModel('sk-x', 'https://example.invalid');
    expect(typeof video).toBe('object');
    expect(typeof image).toBe('object');
    expect(CLOUD_PROVIDERS.video.model).toBe('wan2.7-t2v');
    expect(CLOUD_PROVIDERS.image.model).toBe('seedream-5-0-260128');
  });

  it('给用户看的厂商名字标明是官网的哪一家', () => {
    expect(CLOUD_PROVIDERS.video.label).toContain('通义万相');
    expect(CLOUD_PROVIDERS.image.label).toContain('Seedream');
    for (const info of Object.values(CLOUD_PROVIDERS)) {
      expect(info.consoleUrl).toMatch(/^https:\/\//);
      expect(info.keyHint).not.toBe('');
    }
  });
});
