/**
 * 不经 LLM,直接走一遍代码渲染:分镜 → 构建 → HyperFrames 渲染 → 编码 → 自检 → 入库。
 * 用法:pnpm motion:render -- --title VidRoom [--subtitle ...] [--seconds 10] [--style gradient|minimal]
 * 数据目录照常由 VIDROOM_DATA_DIR 决定(浏览器与 ffmpeg 首次会按清单下载)。
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { dataDir } from '../src/comfyui/install.js';
import { ensureFfmpeg } from '../src/ffmpeg/install.js';
import { VideoLibrary } from '../src/h3/library.js';
import { ensureBrowser } from '../src/motion/browser.js';
import { MotionService } from '../src/motion/service.js';
import type { MotionStyle } from '../src/motion/storyboard.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    title: { type: 'string', default: 'VidRoom' },
    subtitle: { type: 'string' },
    seconds: { type: 'string', default: '10' },
    style: { type: 'string', default: 'gradient' },
  },
});

const root = dataDir();
const log = (m: string) => console.log(m);
const service = new MotionService({
  library: new VideoLibrary(join(root, 'library')),
  ffmpeg: () => ensureFfmpeg({ root, log }),
  browser: () => ensureBrowser({ root, log }),
  workDir: join(root, 'cache', 'motion'),
  homeDir: join(root, 'runtime', 'hyperframes-home'),
  log,
});
const t0 = Date.now();
const r = await service.render({ title: values.title!, subtitle: values.subtitle, seconds: Number(values.seconds), style: values.style as MotionStyle });
console.log(JSON.stringify(r, null, 2));
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
process.exit(r.ok ? 0 : 1);
