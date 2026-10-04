/**
 * dsh-vidroom 的配置。同一份 schema 供 Loader 的入口配置(cordis.yml patch)使用;
 * 插件没有自带设置页,所以字段都是启动时读一次的普通值。
 */
import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  /** ComfyUI 的 HTTP 地址。 */
  baseUrl: z.string().default('http://127.0.0.1:8188'),
  /** 一段视频的等待预算(毫秒)。H3 七秒片在 5080 上要几分钟。 */
  timeoutMs: z.number().min(30_000).max(3_600_000).default(900_000),
  /** 等产物时的轮询间隔(毫秒)。 */
  pollIntervalMs: z.number().min(200).max(10_000).default(1_000),
  /** 显存不到 24 GiB 时是否放行(老 VidRoom 叫实验档)。 */
  allowExperimental: z.boolean().default(false),
});

export type Config = {
  /** ComfyUI 的 HTTP 地址。 */
  baseUrl: string;
  /** 一段视频的等待预算(毫秒)。 */
  timeoutMs: number;
  /** 轮询间隔(毫秒)。 */
  pollIntervalMs: number;
  /** 显存不到 24 GiB 时是否放行。 */
  allowExperimental: boolean;
};

/** Loader 解析过的入口配置 → 插件读的对象(缺项补默认值,地址去尾斜杠)。 */
export function readConfig(raw: Partial<Record<keyof Config, unknown>> = {}): Config {
  const num = (value: unknown, fallback: number): number => (typeof value === 'number' ? value : fallback);
  const str = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim() !== '' ? value.trim().replace(/\/+$/, '') : fallback;
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
  return {
    baseUrl: str(raw.baseUrl, 'http://127.0.0.1:8188'),
    timeoutMs: num(raw.timeoutMs, 900_000),
    pollIntervalMs: num(raw.pollIntervalMs, 1_000),
    allowExperimental: bool(raw.allowExperimental, false),
  };
}
