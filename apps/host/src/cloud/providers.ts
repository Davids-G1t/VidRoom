import { readFileSync } from 'node:fs';
import { createAlibaba } from '@ai-sdk/alibaba';
import { createByteDance } from '@ai-sdk/bytedance';
import { experimental_generateVideo, type ImageModel } from 'ai';

/** AI SDK 没导出视频模型类型,从调用签名里取(视频生成在 v7 仍是 experimental) */
type VideoModel = Parameters<typeof experimental_generateVideo>[0]['model'];

/**
 * 云端的「一家生视频 + 一家生图」(BYOK:用户自己的 key)。
 *
 * key 的存法与本地 LLM 那套完全一致(见 key.ts):
 * - 桌面壳:主进程用 Electron safeStorage 存,经 IPC 给 Host,只留在内存;
 * - 命令行开发:key 放文件,环境变量给「路径」——视频 VIDROOM_CLOUD_VIDEO_KEY_FILE、生图 VIDROOM_CLOUD_IMAGE_KEY_FILE。
 * key 不进日志、不进 HTTP 响应、不写任何数据文件。
 *
 * baseURL 默认走国内站(国内直连即可),只给测试用 VIDROOM_CLOUD_VIDEO_BASE_URL / VIDROOM_CLOUD_IMAGE_BASE_URL 指到假服务。
 */
export type CloudKind = 'video' | 'image';

export const CLOUD_KEY_FILE_ENVS = {
  video: 'VIDROOM_CLOUD_VIDEO_KEY_FILE',
  image: 'VIDROOM_CLOUD_IMAGE_KEY_FILE',
} as const satisfies Record<CloudKind, string>;

export const CLOUD_BASE_URL_ENVS = {
  video: 'VIDROOM_CLOUD_VIDEO_BASE_URL',
  image: 'VIDROOM_CLOUD_IMAGE_BASE_URL',
} as const satisfies Record<CloudKind, string>;

export const CLOUD_VIDEO_MODEL = 'wan2.7-t2v';
export const CLOUD_IMAGE_MODEL = 'seedream-5-0-260128';

/**
 * 国内站地址:百炼 https://dashscope.aliyuncs.com、火山方舟北京站 https://ark.cn-beijing.volces.com/api/v3。
 * 两家官方 SDK 的默认地址都是海外站(dashscope-intl / ark.ap-southeast.bytepluses.com),这里显式改回国内站。
 * 注:百炼的视频接口正在迁往 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com,老地址目前仍可用;
 * 哪天老地址下线,用户可用上面那个 baseURL 环境变量指到新地址。
 */
export const CLOUD_DOMESTIC_BASE_URLS: Record<CloudKind, string> = {
  video: 'https://dashscope.aliyuncs.com',
  image: 'https://ark.cn-beijing.volces.com/api/v3',
};

export interface CloudProviderInfo {
  kind: CloudKind;
  /** 给用户看的厂商与模型 */
  label: string;
  model: string;
  /** 去哪申请 key */
  consoleUrl: string;
  keyHint: string;
}

export const CLOUD_PROVIDERS: Record<CloudKind, CloudProviderInfo> = {
  video: {
    kind: 'video',
    label: '通义万相(阿里云百炼)',
    model: CLOUD_VIDEO_MODEL,
    consoleUrl: 'https://bailian.console.aliyun.com/',
    keyHint: '百炼控制台 → API-KEY',
  },
  image: {
    kind: 'image',
    label: 'Seedream(火山方舟)',
    model: CLOUD_IMAGE_MODEL,
    consoleUrl: 'https://console.volcengine.com/ark',
    keyHint: '方舟控制台 → API Key',
  },
};

/** 环境变量没设、文件不存在或内容为空 → null(视为没配置)。和 key.ts 的 loadKey 一个规矩。 */
export function loadCloudKey(kind: CloudKind, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env[CLOUD_KEY_FILE_ENVS[kind]];
  if (!path) return null;
  try {
    const key = readFileSync(path, 'utf8').trim();
    return key || null;
  } catch {
    return null;
  }
}

export function cloudBaseUrl(kind: CloudKind, env: NodeJS.ProcessEnv = process.env): string {
  return env[CLOUD_BASE_URL_ENVS[kind]]?.trim() || CLOUD_DOMESTIC_BASE_URLS[kind];
}

/** 万相的视频接口是异步的(建任务 + 轮询),AI SDK 的 provider 自己会轮询;chatBaseURL 这里用不到。 */
export function createCloudVideoModel(apiKey: string, baseURL: string): VideoModel {
  return createAlibaba({ apiKey, baseURL, videoBaseURL: baseURL }).video(CLOUD_VIDEO_MODEL);
}

export function createCloudImageModel(apiKey: string, baseURL: string): ImageModel {
  return createByteDance({ apiKey, baseURL }).image(CLOUD_IMAGE_MODEL);
}
