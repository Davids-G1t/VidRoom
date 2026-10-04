/**
 * 仓库卫生:构建入口的源码不能被 .gitignore 吃掉。
 * 2026-10-04 真踩过:根 .gitignore 里一条 `client/` 同时忽略了本包的构建产物目录
 * 与 `src/client/` 源码 —— 本机看着能构建,干净检出会因为缺入口文件而构建失败。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 构建入口:宿主半边与面板半边各一个(见 tsconfig.json / tsdown.config.mjs)。 */
const ENTRY_SOURCES = ['src/index.ts', 'src/client/index.ts'];

/** 跑一条 git 子命令。check-ignore 在「没被忽略」时退出码是 1,所以按状态返回而不是抛出去。 */
function git(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd: packageRoot, encoding: 'utf8' }) };
  } catch (error) {
    const failure = error as { stdout?: string };
    return { ok: false, out: failure.stdout ?? '' };
  }
}

describe('仓库卫生', () => {
  it('构建入口的源码在仓里、没被忽略', () => {
    for (const entry of ENTRY_SOURCES) {
      expect(existsSync(join(packageRoot, entry)), `${entry} 不存在`).toBe(true);

      // --no-index:按「假设这些文件还没进过索引」来判规则 —— 否则已跟踪的文件永远不会报被忽略,
      // 这道闸就彻底失效(实测过)。
      const ignored = git(['check-ignore', '--no-index', entry]);
      expect(ignored.ok, `${entry} 被 .gitignore 忽略了(${ignored.out.trim()})`).toBe(false);

      const tracked = git(['ls-files', '--error-unmatch', entry]);
      expect(tracked.ok, `${entry} 没进 git 索引`).toBe(true);
      expect(tracked.out.trim()).toBe(entry);
    }
  });
});
