import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 用户设置(数据目录里的 settings.json)。目前只有一个开关:不用本机显卡出片(档位按 none 处理)。
 *
 * 与 key 无关,所以是明文 JSON;写入先写临时文件再改名,不会写一半。
 * 页面经 /api/settings 读写,Host 每次用到时现读(重启不丢,改完立刻生效)。
 */
export const SETTINGS_FILE_NAME = 'settings.json';

export interface Settings {
  /** true = 用户选了「不用本机显卡」,本地出片档位一律当成 none */
  forceNoLocalGpu: boolean;
}

export const DEFAULT_SETTINGS: Settings = { forceNoLocalGpu: false };

function parse(raw: unknown): Settings {
  const v = (raw as { forceNoLocalGpu?: unknown } | null)?.forceNoLocalGpu;
  return { forceNoLocalGpu: typeof v === 'boolean' ? v : DEFAULT_SETTINGS.forceNoLocalGpu };
}

export class SettingsStore {
  readonly file: string;

  constructor(readonly dir: string) {
    this.file = join(dir, SETTINGS_FILE_NAME);
  }

  /** 文件不存在或读坏了都当默认值,不抛错 */
  get(): Settings {
    try {
      return parse(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  set(patch: Partial<Settings>): Settings {
    const next: Settings = { ...this.get(), ...parse({ ...this.get(), ...patch }) };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, this.file);
    return next;
  }
}
