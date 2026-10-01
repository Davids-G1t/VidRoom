import { fork, type ChildProcess } from 'node:child_process';
import type { LlmProvider } from '../../host/src/llm-provider.js';
import type { CloudKeyKind, HostToParent, ParentMessage } from '../../host/src/parent-ipc.js';

/**
 * Host 子进程:用 ELECTRON_RUN_AS_NODE=1 把 Electron 自己(process.execPath)当 Node 跑,
 * 不另带 Node 运行时。用 fork() 而不是 spawn():父子之间天然有一条 IPC 通道,
 * API key 只走这条通道(不进环境变量、不进命令行参数)。
 *
 * 主进程拿到 Host 的一次性启动地址后自己去兑换 session cookie,页面的 /api 请求由
 * vidroom-app:// 协议处理器带上 cookie 转发给 Host —— 页面既看不到启动地址也看不到 cookie。
 */

const SESSION_COOKIE_RE = /(?:^|[;,]\s*)(vidroom_session=[0-9a-f]+)/;

/**
 * `VIDROOM_DEEPSEEK_BASE_URL` / `VIDROOM_ANTHROPIC_BASE_URL` 只在 e2e 测试里用来把 LLM 请求指向本机假服务(测试直接
 * 对打包产物设这个环境变量后启动,所以不能在"打包版"这个层面整个禁掉,否则测试基础设施
 * 也跟着断)。打包后的应用继承的是用户级环境变量(Windows 上改 HKCU\Environment 不需要
 * 管理员),不收紧的话,这个变量能把带着已解密 key 的请求指到任意地址。
 *
 * 这条只放行指向回环地址的值,是纵深防御的一层,**不是能排除同用户攻击者的硬边界**——
 * 已经有本机同用户写环境变量能力的攻击者,一样能自己在回环地址起一个监听拦下请求,
 * 或者直接用 NODE_OPTIONS 之类的其它环境变量拿到更大的能力面(Host 现在继承整个
 * process.env,不止这一个变量)。真要堵住"同用户攻击者"这一档,需要把 Host 的环境变量
 * 收成白名单、打包时关掉 --inspect / RunAsNode 这些 fuse——这些留作后续,这条只先挡住
 * "误配置"和"影响不到同一用户环境变量的外部攻击者"这两类,其余一律当作没设置。
 */
export function sanitizeTestBaseURL(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    // new URL(...).hostname 对 IPv6 字面量返回带方括号的形式(如 "[::1]"),裸 "::1" 永远不会出现,不放行它。
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname) ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface HostProcessOptions {
  /** Host 打包产物(host.mjs)路径 */
  script: string;
  /** 聊天页构建产物目录,给 Host 的静态服务用 */
  webDir: string;
  /** 额外给 Host 的环境变量 */
  env?: Record<string, string>;
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

  /** 起 Host 并交给它 key(LLM 一家 + 云端两家);等它监听好、主进程换到 cookie 才返回 */
  async start(
    provider: LlmProvider,
    apiKey: string | null,
    cloudKeys: Record<CloudKeyKind, string | null> = { video: null, image: null },
  ): Promise<void> {
    const log = this.opts.log ?? console.log;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.opts.env,
      ELECTRON_RUN_AS_NODE: '1',
      VIDROOM_WEB_DIR: this.opts.webDir,
    };
    // Host 在 IPC 模式下本来就不读 key 文件;这里也不把开发用的 key 文件路径传下去
    delete env.VIDROOM_DEEPSEEK_KEY_FILE;
    delete env.VIDROOM_ANTHROPIC_KEY_FILE;
    delete env.VIDROOM_CLOUD_VIDEO_KEY_FILE;
    delete env.VIDROOM_CLOUD_IMAGE_KEY_FILE;
    // @ai-sdk/anthropic 在没给 baseURL 时会读 ANTHROPIC_BASE_URL;Host 已显式传官方地址,这里再去掉一层
    delete env.ANTHROPIC_BASE_URL;
    for (const name of ['VIDROOM_DEEPSEEK_BASE_URL', 'VIDROOM_ANTHROPIC_BASE_URL', 'VIDROOM_CLOUD_VIDEO_BASE_URL', 'VIDROOM_CLOUD_IMAGE_BASE_URL']) {
      const safeBaseURL = sanitizeTestBaseURL(env[name]);
      if (env[name] && !safeBaseURL) log(`[vidroom-desktop] 忽略 ${name}(不是回环地址):${env[name]}`);
      if (safeBaseURL) env[name] = safeBaseURL;
      else delete env[name];
    }
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
    this.send({ type: 'set-key', provider, apiKey });
    const first = await ready;
    if (first.type !== 'ready') throw new Error(`Host 首条消息不是 ready:${first.type}`);
    await applied;
    // 云端两家单独交一次(在 ready 之后发,免得回复顺序与等待队列错位)
    await this.setCloudKeys(cloudKeys);
    await this.redeem(first.launchUrl);
  }

  /** 把选用的 LLM 和它的 key 交给 Host,等它换好模型 */
  async setKey(provider: LlmProvider, apiKey: string | null): Promise<void> {
    const applied = this.next();
    this.send({ type: 'set-key', provider, apiKey });
    const msg = await applied;
    if (msg.type !== 'key-applied') throw new Error(`Host 回复不是 key-applied:${msg.type}`);
  }

  /**
   * 把云端两家(生视频 / 生图)的 key 交给 Host。Host 还没起(还没配 LLM key)时静默跳过 ——
   * 那两把 key 存在主进程的加密文件里,下次 start() 会一起带上。
   */
  async setCloudKeys(keys: Record<CloudKeyKind, string | null>): Promise<void> {
    if (!this.child) return;
    const applied = this.next();
    this.send({ type: 'set-cloud-keys', keys });
    const msg = await applied;
    if (msg.type !== 'cloud-keys-applied') throw new Error(`Host 回复不是 cloud-keys-applied:${msg.type}`);
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

  private send(msg: ParentMessage): void {
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
