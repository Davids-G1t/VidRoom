import { fork, type ChildProcess } from 'node:child_process';
import type { HostToParent, SetKeyMessage } from '../../host/src/parent-ipc.js';

/**
 * Host 子进程:用 ELECTRON_RUN_AS_NODE=1 把 Electron 自己(process.execPath)当 Node 跑,
 * 不另带 Node 运行时。用 fork() 而不是 spawn():父子之间天然有一条 IPC 通道,
 * DeepSeek key 只走这条通道(不进环境变量、不进命令行参数)。
 *
 * 主进程拿到 Host 的一次性启动地址后自己去兑换 session cookie,页面的 /api 请求由
 * vidroom-app:// 协议处理器带上 cookie 转发给 Host —— 页面既看不到启动地址也看不到 cookie。
 */

const SESSION_COOKIE_RE = /(?:^|[;,]\s*)(vidroom_session=[0-9a-f]+)/;

export interface HostProcessOptions {
  /** Host 打包产物(host.mjs)路径 */
  script: string;
  /** 聊天页构建产物目录,给 Host 的静态服务用 */
  webDir: string;
  log?: (msg: string) => void;
}

export class HostProcess {
  private child: ChildProcess | null = null;
  private origin = '';
  private cookie = '';
  private readonly waiters: Array<(msg: HostToParent) => void> = [];

  constructor(private readonly opts: HostProcessOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** 起 Host 并交给它 key;等它监听好、主进程换到 cookie 才返回 */
  async start(apiKey: string | null): Promise<void> {
    const log = this.opts.log ?? console.log;
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', VIDROOM_WEB_DIR: this.opts.webDir };
    // Host 在 IPC 模式下本来就不读 key 文件;这里也不把开发用的 key 文件路径传下去
    delete env.VIDROOM_DEEPSEEK_KEY_FILE;
    const child = fork(this.opts.script, [], {
      execPath: process.execPath,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    });
    this.child = child;
    child.stdout?.on('data', (d) => process.stdout.write(`[host] ${d}`));
    child.stderr?.on('data', (d) => process.stderr.write(`[host] ${d}`));
    child.on('message', (msg) => {
      const waiter = this.waiters.shift();
      waiter?.(msg as HostToParent);
    });
    child.once('exit', (code, signal) => {
      log(`[vidroom-desktop] Host 子进程退出 pid=${child.pid} code=${code} signal=${signal}`);
      if (this.child === child) this.child = null;
    });
    log(`[vidroom-desktop] Host 子进程已启动 pid=${child.pid}`);

    const ready = this.next();
    const applied = this.next();
    this.send({ type: 'set-key', apiKey });
    const first = await ready;
    if (first.type !== 'ready') throw new Error(`Host 首条消息不是 ready:${first.type}`);
    await applied;
    await this.redeem(first.launchUrl);
  }

  /** 把新 key 交给 Host,等它换好模型 */
  async setKey(apiKey: string | null): Promise<void> {
    const applied = this.next();
    this.send({ type: 'set-key', apiKey });
    const msg = await applied;
    if (msg.type !== 'key-applied') throw new Error(`Host 回复不是 key-applied:${msg.type}`);
  }

  /** 带上 session cookie 转发一个 /api 请求给 Host */
  fetchApi(pathAndQuery: string, init: { method: string; body?: ArrayBuffer; contentType?: string | null }): Promise<Response> {
    if (!this.child || !this.cookie) return Promise.resolve(Response.json({ error: 'host_down' }, { status: 502 }));
    const headers: Record<string, string> = { cookie: this.cookie };
    if (init.contentType) headers['content-type'] = init.contentType;
    return fetch(`${this.origin}${pathAndQuery}`, { method: init.method, headers, body: init.body });
  }

  /** 杀掉 Host(应用退出时调用)。Windows 上 kill() 即 TerminateProcess。 */
  kill(): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.kill();
  }

  private send(msg: SetKeyMessage): void {
    if (!this.child?.connected) throw new Error('Host 子进程不在');
    this.child.send(msg);
  }

  private next(timeoutMs = 30_000): Promise<HostToParent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等 Host 回复超时')), timeoutMs);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  private async redeem(launchUrl: string): Promise<void> {
    const res = await fetch(launchUrl, { redirect: 'manual' });
    const m = (res.headers.get('set-cookie') ?? '').match(SESSION_COOKIE_RE);
    if (res.status !== 303 || !m) throw new Error(`兑换启动地址失败:HTTP ${res.status}`);
    this.origin = new URL(launchUrl).origin;
    this.cookie = m[1];
  }
}
