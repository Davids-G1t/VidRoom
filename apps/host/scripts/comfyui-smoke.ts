/**
 * ComfyUI 起停冒烟(真 ComfyUI,不是假的)。用法见 README「ComfyUI」一节,常用:
 *
 *   # Windows(CI):下载官方便携包(中途故意断一次再续传)→ 校验 → 解压 → 查 torch 的 CUDA 版本 → --cpu 起停
 *   pnpm --filter @vidroom/host comfyui:smoke -- --interrupt-download-at 104857600 --cpu
 *   # Linux 开发机:复用已装好的 ComfyUI,真显卡起停,核对设备名
 *   VIDROOM_COMFYUI_DIR=<ComfyUI 目录> pnpm --filter @vidroom/host comfyui:smoke -- --expect-device "RTX 4060 Ti"
 *
 * 参数:
 *   --cpu                         给 ComfyUI 加 --cpu(不用显卡)
 *   --expect-device <片段>        /system_stats 的第一个设备名必须含这个片段
 *   --interrupt-download-at <n>   (只在要下载时)下到 n 字节时主动中断,再调一次验证从断点续传
 *   --install-only                只下载/解压,不起 ComfyUI
 *   --hold <秒>                   就绪后挂这么久再停(给跨机连通性测试留时间)
 *
 * 检查项:版本门槛(ComfyUI ≥ 0.30.0、PyTorch CUDA ≥ 13.0)、只监听 127.0.0.1(Linux 用 ss -tlnp,
 * Windows 用 Get-NetTCPConnection)、停止后 30 秒内没有 ComfyUI 进程残留。任何一项不过,退出码非 0。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { COMFYUI_DIR_ENV, dataDir, ensurePortable, localInstall, type ComfyInstall } from '../src/comfyui/install.js';
import { COMFYUI_PORTABLE } from '../src/comfyui/manifest.js';
import { ComfyProcess } from '../src/comfyui/process.js';
import { checkVersions, compareVersions, cudaFromTorchVersion, MIN_TORCH_CUDA } from '../src/comfyui/versions.js';

const { values: opts } = parseArgs({
  // pnpm 会把 `--` 原样传进来
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    cpu: { type: 'boolean', default: false },
    'expect-device': { type: 'string' },
    'interrupt-download-at': { type: 'string' },
    'install-only': { type: 'boolean', default: false },
    hold: { type: 'string' },
  },
});

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const log = (m: string) => console.log(m);

async function getInstall(): Promise<ComfyInstall> {
  if (process.env[COMFYUI_DIR_ENV] || process.platform !== 'win32') return localInstall();
  const root = dataDir();
  const stopAt = opts['interrupt-download-at'] ? Number(opts['interrupt-download-at']) : null;
  if (stopAt) {
    const ac = new AbortController();
    try {
      await ensurePortable(root, {
        signal: ac.signal,
        log,
        onProgress: (p) => {
          if (p.phase === 'downloading' && (p.received ?? 0) >= stopAt) ac.abort();
        },
      });
      console.log('(便携包已装好,跳过断点续传验证)');
    } catch (err) {
      check(ac.signal.aborted, `下载在 ${stopAt} 字节处被主动中断(${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const t0 = Date.now();
  let last = 0;
  const { install, download } = await ensurePortable(root, {
    log,
    onProgress: (p) => {
      if (p.phase === 'downloading' && Date.now() - last > 15_000) {
        last = Date.now();
        console.log(`  下载 ${((p.received ?? 0) / 2 ** 20).toFixed(0)} / ${((p.total ?? 0) / 2 ** 20).toFixed(0)} MiB`);
      }
      if (p.phase === 'extracting') console.log('  解压中…');
    },
  });
  console.log(`便携包就绪,用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒:${install.comfyDir}`);
  if (download && stopAt) {
    const from = download.resumedFrom[0] ?? 0;
    check(from > 0 && from <= stopAt + 16 * 2 ** 20, `第二次下载从第 ${from} 字节续传(不是从 0 重来)`);
  }
  if (download) check(true, `sha256 与清单一致(${COMFYUI_PORTABLE.sha256})`);
  return install;
}

/** 便携包自带 Python 里 torch 的 CUDA 版本:不起 ComfyUI、不要显卡也能查 */
function torchCudaOf(python: string): void {
  const r = spawnSync(python, ['-s', '-c', 'import torch; print(torch.__version__); print(torch.version.cuda)'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const [ver, cuda] = r.stdout.trim().split(/\r?\n/);
  console.log(`torch.__version__ = ${ver},torch.version.cuda = ${cuda}`);
  const c = cudaFromTorchVersion(cuda) ?? cuda;
  check(r.status === 0 && !!c && compareVersions(c, MIN_TORCH_CUDA) >= 0, `PyTorch CUDA 版本 ${cuda} ≥ ${MIN_TORCH_CUDA}`);
}

/** 这个 pid 在监听的全部 TCP 地址 */
function listeningAddrs(pid: number): string[] {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalAddress + ' ' + $_.LocalPort }`,
      ],
      { encoding: 'utf8' },
    );
    console.log(`Get-NetTCPConnection -State Listen -OwningProcess ${pid}:\n${out.trim()}`);
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.replace(' ', ':'));
  }
  const out = execFileSync('ss', ['-tlnpH'], { encoding: 'utf8' });
  const mine = out.split('\n').filter((l) => l.includes(`pid=${pid},`));
  console.log(`ss -tlnp(pid=${pid}):\n${mine.join('\n')}`);
  return mine.map((l) => l.trim().split(/\s+/)[3]);
}

/** 命令行里带着 ComfyUI 目录的进程(python 本体和它可能起的子进程) */
function comfyProcesses(comfyDir: string): string[] {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${comfyDir.replace(/'/g, "''")}') } | ForEach-Object { [string]$_.ProcessId + ' ' + $_.Name }`,
      ],
      { encoding: 'utf8' },
    );
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.includes(comfyDir) && !l.includes('comfyui-smoke'));
}

const install = await getInstall();
if (install.source === 'portable') torchCudaOf(install.python);

if (!opts['install-only']) {
  const t0 = Date.now();
  const proc = await ComfyProcess.start({ install, extraArgs: opts.cpu ? ['--cpu'] : [], readyTimeoutMs: 300_000, log });
  console.log(`ComfyUI 就绪,用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒,pid=${proc.pid},端口=${proc.port}`);
  try {
    const stats = await proc.systemStats();
    console.log(`/system_stats: ${JSON.stringify({ system: { ...stats.system, argv: undefined }, devices: stats.devices })}`);
    const v = checkVersions(stats);
    console.log(`comfyui_version=${v.comfyuiVersion} pytorch_version=${v.pytorchVersion} → CUDA ${v.torchCuda}`);
    check(v.ok, `版本门槛(ComfyUI ≥ 0.30.0、PyTorch CUDA ≥ 13.0)${v.problems.length ? ':' + v.problems.join(';') : ''}`);
    const first = stats.devices[0]?.name ?? '';
    if (opts['expect-device']) check(first.includes(opts['expect-device']), `设备名「${first}」含「${opts['expect-device']}」`);

    const addrs = listeningAddrs(proc.pid);
    check(addrs.length > 0 && addrs.every((a) => a.startsWith('127.0.0.1:')), `ComfyUI 进程只监听 127.0.0.1:${addrs.join(', ')}`);
    check(addrs.includes(`127.0.0.1:${proc.port}`), `监听的就是分配给它的随机端口 ${proc.port}`);

    if (opts.hold) {
      console.log(`\n挂 ${opts.hold} 秒供跨机测试。在另一台机器上跑(预期连不上):`);
      console.log(`  curl --max-time 3 http://<本机局域网或 tailnet 地址>:${proc.port}/system_stats\n`);
      await sleep(Number(opts.hold) * 1000);
    }
  } finally {
    const r = await proc.stop();
    const stoppedServer = proc.output().includes('Stopped server');
    console.log(
      `停止:${r.graceful ? 'ComfyUI 自己正常退出' : '被强杀/兜底退出'}(code=${r.code} signal=${r.signal});日志里${stoppedServer ? '有' : '没有'} "Stopped server"`,
    );
  }

  const t1 = Date.now();
  let left = comfyProcesses(install.comfyDir);
  while (left.length > 0 && Date.now() - t1 < 30_000) {
    await sleep(1_000);
    left = comfyProcesses(install.comfyDir);
  }
  check(left.length === 0, `停止后 30 秒内没有 ComfyUI 进程残留${left.length ? ':' + left.join('; ') : `(${Date.now() - t1} 毫秒内确认)`}`);
}

console.log(failures.length ? `\n${failures.length} 项不通过` : '\n全部通过');
process.exit(failures.length ? 1 : 0);
