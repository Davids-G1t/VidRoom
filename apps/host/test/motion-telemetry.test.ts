import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HEADLESS_SHELL_VERSION } from '../src/motion/browser.js';
import { hyperframesCli, hyperframesEnv } from '../src/motion/render.js';
import { testTmpDir } from './fixtures/media.js';

/**
 * 验收③:发行配置里 HyperFrames 的遥测是关的。
 * 两层:① 直接断言发行代码给 HyperFrames 子进程的环境变量(hyperframesEnv 是唯一定义处);
 * ② 用锁定版本的真 HyperFrames CLI 跑 `hyperframes telemetry status`(这条命令本身不上报),
 *    看它自己报「disabled,来源 HYPERFRAMES_NO_TELEMETRY」—— 证明这是它真认的开关,不是我们凭空写的变量名。
 *    对照组:不带这两个变量时同一个 CLI 报 enabled(说明发行构建默认是开的,关掉它靠的正是这个变量)。
 * 需要先 `pnpm hyperframes:install`;没装就失败,不跳过。
 */

const ff = { ffmpeg: '/x/ffmpeg', ffprobe: '/x/ffprobe', configuration: '' };
const home = testTmpDir('hf-home-');

afterAll(() => rmSync(home, { recursive: true, force: true }));

function status(env: NodeJS.ProcessEnv): string {
  const r = spawnSync(process.execPath, [hyperframesCli(env), 'telemetry', 'status'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

describe('HyperFrames 遥测', () => {
  const env = hyperframesEnv({ base: { PATH: process.env.PATH }, browser: '/x/chrome', ff, tmpDir: home, homeDir: home });

  it('发行配置的环境变量:遥测、查新版本、自动安装全关,家目录与临时目录指到数据目录', () => {
    expect(env).toMatchObject({
      HYPERFRAMES_NO_TELEMETRY: '1',
      DO_NOT_TRACK: '1',
      HYPERFRAMES_NO_UPDATE_CHECK: '1',
      HYPERFRAMES_NO_AUTO_INSTALL: '1',
      HYPERFRAMES_BROWSER_PATH: '/x/chrome',
      HYPERFRAMES_FFMPEG_PATH: '/x/ffmpeg',
      HYPERFRAMES_FFPROBE_PATH: '/x/ffprobe',
      HOME: home,
      USERPROFILE: home,
      TMPDIR: home,
      TEMP: home,
      TMP: home,
    });
  });

  it('锁定版本的 HyperFrames 已装好(pnpm hyperframes:install)', () => {
    expect(existsSync(hyperframesCli(env)), `找不到 ${hyperframesCli(env)},先跑 pnpm hyperframes:install`).toBe(true);
  });

  it('真 CLI 在发行环境变量下自报 disabled,来源 HYPERFRAMES_NO_TELEMETRY', () => {
    const out = status(env);
    expect(out).toMatch(/Status:\s+disabled/);
    expect(out).toMatch(/Source:\s+HYPERFRAMES_NO_TELEMETRY/);
  });

  it('对照组:去掉这两个变量,同一个 CLI 报 enabled(发行构建默认开)', () => {
    const plain = { ...env };
    delete plain.HYPERFRAMES_NO_TELEMETRY;
    delete plain.DO_NOT_TRACK;
    const out = status(plain);
    expect(out).toMatch(/Status:\s+enabled/);
  });

  it('浏览器清单锁的版本与 HyperFrames 自己锁的 chrome-headless-shell 一致(升级 HyperFrames 时提醒一起改)', () => {
    const dist = join(hyperframesCli(env), '..', '..', 'dist');
    const hit = readdirSync(dist)
      .filter((f) => f.endsWith('.js'))
      .map((f) => /(?<![A-Z0-9_])CHROME_VERSION = "([0-9.]+)"/.exec(readFileSync(join(dist, f), 'utf8'))?.[1])
      .find(Boolean);
    expect(hit).toBe(HEADLESS_SHELL_VERSION);
    expect(readFileSync(join(hyperframesCli(env), '..', '..', 'package.json'), 'utf8')).toContain('"version": "0.8.98"');
  });
});
