import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hostDir = fileURLToPath(new URL('../apps/host/', import.meta.url));

export interface RunningHost {
  launchUrl: string;
  origin: string;
  output: () => string;
  stop: () => Promise<void>;
}

/** 起一个真实的 Host 进程,从控制台读出启动地址 */
export async function startHostProcess(env: NodeJS.ProcessEnv): Promise<RunningHost> {
  // 用 `node --import tsx` 单进程跑,kill 时不会在 Windows 上留下孤儿子进程
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: hostDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));

  const launchUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Host 30 秒内没打印启动地址:\n${out}`)), 30_000);
    const check = () => {
      const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/launch\?token=[0-9a-f]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout!.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Host 提前退出(${code}):\n${out}`));
    });
  });

  return {
    launchUrl,
    origin: new URL(launchUrl).origin,
    output: () => out,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}

/** 去掉 key 相关环境变量后的环境 */
export function envWithoutKey(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.VIDROOM_DEEPSEEK_KEY_FILE;
  return env;
}
