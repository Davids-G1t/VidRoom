// 用 esbuild 打三个产物:主进程、preload(沙箱里只能是 CommonJS)、Host(连同依赖打成一个文件,
// 这样安装包里不用带 node_modules)。
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: false, logLevel: 'info' };

await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', format: 'cjs', external: ['electron'] });
await build({
  ...common,
  entryPoints: ['../host/src/main.ts'],
  outfile: 'dist/host/host.mjs',
  format: 'esm',
  // 依赖里有 CommonJS 的 require,ESM 产物里要自己补一个
  banner: { js: "import { createRequire as __vidroomCreateRequire } from 'node:module'; const require = __vidroomCreateRequire(import.meta.url);" },
});
