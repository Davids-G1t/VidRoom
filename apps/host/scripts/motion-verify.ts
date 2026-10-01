/**
 * 交付前自检,单独对任意 MP4 跑:MP4 探测 + 冻帧检测 + 联系表。
 * 用法:pnpm motion:verify -- <视频.mp4> --seconds 10 [--fps 30] [--sheet 联系表.png]
 * 通过退出码 0,不通过 1;报告打印成 JSON。
 */
import { parseArgs } from 'node:util';
import { ensureFfmpeg } from '../src/ffmpeg/install.js';
import { verifyVideo } from '../src/motion/verify.js';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  allowPositionals: true,
  options: { seconds: { type: 'string' }, fps: { type: 'string', default: '30' }, sheet: { type: 'string' } },
});
const file = positionals[0];
if (!file || !values.seconds) {
  console.error('用法:pnpm motion:verify -- <视频.mp4> --seconds <秒> [--fps 30] [--sheet 联系表.png]');
  process.exit(2);
}
const ff = await ensureFfmpeg({ log: (m) => console.error(m) });
const report = await verifyVideo(ff, file, { seconds: Number(values.seconds), fps: Number(values.fps) }, values.sheet ?? file.replace(/\.mp4$/i, '') + '.contact.png');
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
