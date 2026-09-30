import { dirname } from 'node:path';
import { ensureFfmpeg } from '../src/ffmpeg/install.js';

/**
 * 按清单下载并解压锁定的 LGPL ffmpeg 到数据目录(VIDROOM_DATA_DIR,不设就是默认数据目录),
 * 打印 configuration 行;带 --enable-gpl 会直接报错退出。最后一行输出 bin 目录,CI 用它加进 PATH。
 */
const ff = await ensureFfmpeg({ log: (m) => console.log(m) });
console.log(`ffmpeg: ${ff.ffmpeg}`);
console.log(`configuration: ${ff.configuration}`);
console.log(`--enable-gpl 出现在 configuration 里:${ff.configuration.split(/\s+/).includes('--enable-gpl') ? '是' : '否'}`);
console.log(dirname(ff.ffmpeg));
