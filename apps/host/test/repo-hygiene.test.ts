import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 公开仓不放 MiniMax H3 成片或截帧:仓库里不许有视频文件,也不许有图片(截图只进 CI 产物,不进仓库)。
 * 许可义务文件必须都在。
 */
const root = fileURLToPath(new URL('../../../', import.meta.url));

describe('仓库卫生', () => {
  it('git 跟踪的文件里没有视频与图片', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(files.length).toBeGreaterThan(50);
    const media = files.filter((f) => /\.(mp4|webm|mkv|mov|avi|gif|png|jpe?g|webp|bmp)$/i.test(f));
    expect(media).toEqual([]);
  });

  it('许可义务文件齐全', () => {
    for (const f of [
      '.github/ISSUE_TEMPLATE/abuse-report.yml',
      'docs/abuse.md',
      'docs/USE-POLICY.md',
      'apps/web/public/licenses/MiniMax-H3-LICENSE.txt',
      'apps/web/public/licenses/MiniMax-H3-NOTICE.txt',
    ]) {
      expect(existsSync(root + f), f).toBe(true);
    }
    expect(readFileSync(root + '.github/ISSUE_TEMPLATE/abuse-report.yml', 'utf8')).toMatch(/labels:\s*\["abuse"\]/);
  });
});
