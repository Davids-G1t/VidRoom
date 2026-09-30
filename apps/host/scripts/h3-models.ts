/**
 * 命令行核对/补齐 MiniMax H3 权重(开发机用;普通用户走页面上的许可同意页)。
 *   pnpm --filter @vidroom/host h3:models            只核对:逐个文件报 ok / missing / mismatch
 *   pnpm --filter @vidroom/host h3:models -- --download   核对后下载缺的(已有且 sha256 对得上的跳过)
 * 模型目录:VIDROOM_MODELS_DIR,默认 <数据目录>/models。
 * 注意:--download 视为你本人已阅读并同意 MiniMax H3 社区许可(apps/web/public/licenses/MiniMax-H3-LICENSE.txt)。
 */
import { join } from 'node:path';
import { dataDir } from '../src/comfyui/install.js';
import { ModelStore, modelsDir } from '../src/h3/models.js';

const dir = modelsDir();
const store = new ModelStore(dir, join(dataDir(), 'cache', 'model-sha256.json'));
const t0 = Date.now();
const before = await store.inspect();
for (const s of before) console.log(`[h3] ${s.state.padEnd(8)} ${s.folder}/${s.fileName} (${s.size} 字节)`);
console.log(`[h3] 核对耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒,模型目录 ${dir}`);

if (process.argv.includes('--download')) {
  let last = 0;
  const got = await store.downloadMissing({
    log: (m) => console.log(m),
    onFile: (f) => console.log(`[h3] 下载 ${f.folder}/${f.fileName}`),
    onProgress: (r, t) => {
      if (Date.now() - last > 5_000) {
        last = Date.now();
        console.log(`[h3]   ${(r / 2 ** 20).toFixed(0)} / ${(t / 2 ** 20).toFixed(0)} MiB`);
      }
    },
  });
  console.log(`[h3] 下载了 ${got.length} 个文件:${got.map((f) => f.fileName).join(', ') || '(无)'}`);
  for (const s of await store.inspect()) console.log(`[h3] ${s.state.padEnd(8)} ${s.folder}/${s.fileName}`);
}
