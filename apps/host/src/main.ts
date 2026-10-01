import { totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModel } from './agent.js';
import { PROVIDER_LABELS, type LlmProvider } from './llm-provider.js';
import { dataDir } from './comfyui/install.js';
import { ComfyManager, defaultMemoryLimitMiB, parseExtraArgs } from './comfyui/manager.js';
import { VideoEditor } from './ffmpeg/editor.js';
import { ensureFfmpeg } from './ffmpeg/install.js';
import { probeGpu } from './gpu.js';
import { ConsentStore } from './h3/license.js';
import { VideoLibrary } from './h3/library.js';
import { ModelStore, h3ModelFiles, modelsDir, writeExtraModelPaths } from './h3/models.js';
import { VideoService } from './h3/service.js';
import { BASE_URL_ENVS, KEY_FILE_ENVS, loadKey, providerFromEnv } from './key.js';
import { ensureBrowser } from './motion/browser.js';
import { MotionService } from './motion/service.js';
import { parseParentMessage, type HostToParent } from './parent-ipc.js';
import { startHost } from './server.js';
import { WorkflowService } from './workflows/service.js';

const webDir = process.env.VIDROOM_WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const port = Number(process.env.VIDROOM_PORT ?? 0);

// ComfyUI 只在用户点「启动 ComfyUI」或第一次出片时才找/下载/起;VIDROOM_COMFYUI_ARGS 给它加参数(如 --cpu)。
// 模型目录和 ComfyUI 本体分开放,经 --extra-model-paths-config 告诉 ComfyUI 去哪找权重。
const data = dataDir();
const models = modelsDir();
const extraModelPaths = join(data, 'extra_model_paths.yaml');
await writeExtraModelPaths(extraModelPaths, models);
const comfy = new ComfyManager({
  extraArgs: ['--extra-model-paths-config', extraModelPaths, ...parseExtraArgs(process.env.VIDROOM_COMFYUI_ARGS)],
  memoryLimitMiB: defaultMemoryLimitMiB(totalmem()),
});
const library = new VideoLibrary(join(data, 'library'));
const video = new VideoService({
  comfy,
  models: new ModelStore(models, join(data, 'cache', 'model-sha256.json'), h3ModelFiles()),
  consent: new ConsentStore(join(data, 'h3-consent.json')),
  library,
  probeGpu: () => probeGpu(),
});
// ffmpeg 第一次剪辑时才按清单下载(LGPL 构建);临时文件放数据目录,不用系统临时目录
const editor = new VideoEditor({
  library,
  ffmpeg: () => ensureFfmpeg({ root: data, log: (m) => console.log(m) }),
  workDir: join(data, 'cache', 'edit'),
  log: (m) => console.log(m),
});

// 代码渲染(HyperFrames):不占显卡;chrome-headless-shell 与 ffmpeg 都在第一次渲染时按清单下载
const motion = new MotionService({
  library,
  ffmpeg: () => ensureFfmpeg({ root: data, log: (m) => console.log(m) }),
  browser: () => ensureBrowser({ root: data, log: (m) => console.log(m) }),
  workDir: join(data, 'cache', 'motion'),
  homeDir: join(data, 'runtime', 'hyperframes-home'),
  log: (m) => console.log(m),
});
const workflows = new WorkflowService(join(data, 'workflows'), null, { video, editor, motion });

const modelFor = (provider: LlmProvider, apiKey: string | null) =>
  apiKey ? createModel(provider, apiKey, process.env[BASE_URL_ENVS[provider]] || undefined) : null;

/**
 * 两种起法:
 * - 桌面壳用 child_process.fork() 起(有 IPC 通道):key 只从 IPC 通道收,不读文件、不读环境变量;
 *   启动地址也只从 IPC 回给壳,不打印。父进程断开(壳退出或崩溃)就跟着退出,不留孤儿。
 * - 命令行起(开发用):VIDROOM_LLM_PROVIDER 选 deepseek(默认)或 anthropic,key 从对应的
 *   VIDROOM_DEEPSEEK_KEY_FILE / VIDROOM_ANTHROPIC_KEY_FILE 指向的文件读,启动地址打印到控制台。
 */
if (process.send) {
  const send = (msg: HostToParent) => process.send!(msg);
  let host: Awaited<ReturnType<typeof startHost>> | null = null;

  const handle = async (raw: unknown) => {
    const msg = parseParentMessage(raw);
    if (msg === null) {
      console.error('[vidroom] 忽略格式不对的父进程消息');
      return;
    }
    const secrets = msg.apiKey ? [msg.apiKey] : [];
    const nextModel = modelFor(msg.provider, msg.apiKey);
    workflows.setModel(nextModel);
    if (host === null) {
      // 第一条 set-key 到了才起服务,页面第一次查状态时 key 已就位
      host = await startHost({ model: nextModel, webDir, port, secrets, comfy, video, editor, motion, workflows });
      send({ type: 'ready', launchUrl: host.launchUrl });
    } else {
      host.setModel(nextModel, secrets);
    }
    send({ type: 'key-applied', hasApiKey: msg.apiKey !== null });
  };
  // 消息按到达顺序逐条处理,免得两条 set-key 同时起两个服务
  let queue = Promise.resolve();
  process.on('message', (raw) => {
    queue = queue.then(() => handle(raw)).catch((err) => {
      console.error('[vidroom] 处理父进程消息出错:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
  });
  // 壳退出/崩溃(IPC 断开)或发来 SIGTERM(Linux 上壳的 kill()):先停 ComfyUI 再退出。
  // 壳在 Windows 上 kill() 是强杀,走不到这里 —— 那时 ComfyUI 靠 stdin 断开自己退出(见 comfyui/process.ts)。
  let exiting = false;
  const shutdown = () => {
    if (exiting) return;
    exiting = true;
    comfy.stop().finally(() => process.exit(0));
  };
  process.on('disconnect', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} else {
  const provider = providerFromEnv();
  const apiKey = loadKey(provider);
  const initialModel = modelFor(provider, apiKey);
  workflows.setModel(initialModel);
  const host = await startHost({ model: initialModel, webDir, port, secrets: apiKey ? [apiKey] : [], comfy, video, editor, motion, workflows });

  if (!apiKey) {
    console.log(`[vidroom] 没有配置 ${PROVIDER_LABELS[provider]} API key(环境变量 ${KEY_FILE_ENVS[provider]} 未设置或文件不存在),聊天功能不可用。`);
  }
  console.log(`[vidroom] 启动地址(只能用一次): ${host.launchUrl}`);

  const shutdown = () => {
    host.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
