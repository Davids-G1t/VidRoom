import { describe, expect, it } from 'vitest';
import { escapeFilterValue, concatListLine, findFont } from '../src/ffmpeg/edit.js';
import { ensureFfmpeg, ffmpegBuildFor, licenseProblem } from '../src/ffmpeg/install.js';
import { FFMPEG_BUILDS, FFMPEG_DOWNLOAD_URL_ENV, ffmpegDownloadUrl } from '../src/ffmpeg/manifest.js';

describe('ffmpeg 清单', () => {
  it('Windows 与 Linux 各锁一份 LGPL 构建,sha256 是 64 位十六进制', () => {
    for (const p of ['win32', 'linux'] as const) {
      const b = FFMPEG_BUILDS[p]!;
      expect(b.fileName).toMatch(/-lgpl-/);
      expect(b.fileName).not.toMatch(/-gpl-/);
      expect(b.url).toBe(`https://github.com/BtbN/FFmpeg-Builds/releases/download/${b.releaseTag}/${b.fileName}`);
      expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(b.size).toBeGreaterThan(10_000_000);
      expect(b.fileName.startsWith(b.rootDir)).toBe(true);
    }
    expect(() => ffmpegBuildFor('darwin')).toThrow(/Windows 与 Linux/);
  });

  it('镜像地址环境变量', () => {
    const b = FFMPEG_BUILDS.linux!;
    expect(ffmpegDownloadUrl(b, {})).toBe(b.url);
    expect(ffmpegDownloadUrl(b, { [FFMPEG_DOWNLOAD_URL_ENV]: ' http://mirror/x.tar.xz ' })).toBe('http://mirror/x.tar.xz');
  });
});

describe('许可证检查', () => {
  it('configuration 行带 --enable-gpl 或 --enable-nonfree 就拒绝', () => {
    expect(licenseProblem('ffmpeg version 7\nconfiguration: --prefix=/usr --enable-gpl --enable-libx264\n').problem).toMatch(/--enable-gpl/);
    expect(licenseProblem('configuration: --enable-version3 --enable-nonfree\n').problem).toMatch(/--enable-nonfree/);
    expect(licenseProblem('configuration: --enable-version3 --disable-libx264 --enable-libopenh264\n').problem).toBeNull();
    expect(licenseProblem('ffmpeg version 7\n').problem).toMatch(/没有 configuration/);
  });

  it('真下载的锁定构建:configuration 行里没有 --enable-gpl,带 libopenh264、不带 libx264', async () => {
    const ff = await ensureFfmpeg({ log: (m) => console.log(m) });
    console.log(`[ffmpeg] ${ff.ffmpeg}\n[ffmpeg] configuration: ${ff.configuration}`);
    const flags = ff.configuration.split(/\s+/);
    expect(flags).not.toContain('--enable-gpl');
    expect(flags).toContain('--enable-libopenh264');
    expect(flags).toContain('--disable-libx264');
    expect(licenseProblem(`configuration: ${ff.configuration}`).problem).toBeNull();
  }, 600_000);
});

describe('滤镜转义与字体', () => {
  it('两层转义与 ffmpeg-filters 文档示例一致', () => {
    // 文档「Notes on filtergraph escaping」的例子
    expect(escapeFilterValue("this is a 'string': may contain one, or more, special characters")).toBe(
      "this is a \\\\\\'string\\\\\\'\\\\: may contain one\\, or more\\, special characters",
    );
    expect(escapeFilterValue('C:/Windows/Fonts/msyh.ttc')).toBe('C\\\\:/Windows/Fonts/msyh.ttc');
  });

  it('concat 列表里的单引号', () => {
    expect(concatListLine("/a/it's.mp4")).toBe("file '/a/it'\\''s.mp4'");
  });

  it('按平台找字体,优先带中文字形的', () => {
    const win = findFont('win32', { WINDIR: 'C:\\Windows' }, (p) => /simhei|arial/.test(p));
    expect(win).toEqual({ path: expect.stringMatching(/simhei\.ttf$/), cjk: true });
    expect(findFont('win32', { WINDIR: 'C:\\Windows' }, (p) => /arial/.test(p))?.cjk).toBe(false);
    expect(findFont('linux', {}, (p) => p.includes('wqy-microhei'))?.path).toBe('/usr/share/fonts/truetype/wqy/wqy-microhei.ttc');
    expect(findFont('linux', {}, () => false)).toBeNull();
    expect(findFont('linux', { VIDROOM_SUBTITLE_FONT: '/x/my.ttf' }, () => true)).toEqual({ path: '/x/my.ttf', cjk: true });
    expect(() => findFont('linux', { VIDROOM_SUBTITLE_FONT: '/x/no.ttf' }, () => false)).toThrow(/不存在/);
  });
});
