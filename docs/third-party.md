# 第三方组件:来源与许可

本页只记 VidRoom 自己下载、打包或调用的外部组件。ComfyUI、MiniMax H3、ffmpeg 的说明见 [README](../README.md) 的「许可」一节。

## HyperFrames(代码渲染视频)

| 项 | 值 |
|---|---|
| 是什么 | [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes):用 HTML 描述动画,再逐帧渲染成视频 |
| 版本 | npm 包 `hyperframes@0.8.98`(2026-09-30 发布),锁在 `apps/host/hyperframes/package-lock.json` |
| 许可 | Apache-2.0 |
| 怎么来 | `pnpm hyperframes:install`(`npm ci --ignore-scripts --omit=dev`,按锁文件装,不跑安装脚本)。Windows 安装包把它连同 node_modules 放进 `resources/hyperframes` 一起分发 |
| 怎么用 | Host 以子进程跑它的 CLI:`hyperframes render <合成目录> --format png-sequence`,拿到逐帧 PNG 后,由 VidRoom 自己的 LGPL ffmpeg 编码 |

为什么不让 HyperFrames 直接出 MP4:它的 MP4 编码只认 libx264(GPL)或 VideoToolbox(仅 macOS),在 VidRoom 锁定的 LGPL ffmpeg 上会报 `H264EncoderUnavailableError`(源码 `packages/cli/src/browser/ffmpeg.ts`)。改成 png-sequence 输出后,这一步用不到 H.264 编码器。

安装包里随 HyperFrames 一起分发的依赖共 75 个 npm 包。按各包 `package.json` 的 license 字段统计,大部分是 MIT / Apache-2.0 / ISC / BSD。例外是 `sharp` 自带的 libvips 原生库:`@img/sharp-libvips-*` 为 LGPL-3.0-or-later,`@img/sharp-win32-x64` 为 Apache-2.0 AND LGPL-3.0-or-later。libvips 以未修改的共享库形式由 sharp 动态加载,不链接进 VidRoom 主程序,许可文本就在各包目录里。

### 遥测、查新版本、自动升级:一律关掉

npm 上发布的 CLI 构建**默认开着遥测**:它带有真的 PostHog key,对照测试里不设开关时,`hyperframes telemetry status` 报 `enabled`。关闭方式以它自己的源码为准(`packages/cli/src/telemetry/policy.ts`):环境变量 `HYPERFRAMES_NO_TELEMETRY` 或 `DO_NOT_TRACK` 取 `1/true/yes/on` 就关,并且优先于用户配置文件。

VidRoom 给 HyperFrames 子进程设的环境变量只在 `apps/host/src/motion/render.ts` 的 `hyperframesEnv()` 里定义:

- `HYPERFRAMES_NO_TELEMETRY=1` 和 `DO_NOT_TRACK=1`:关遥测。两个都设,其中一个将来改名,另一个还能兜底;
- `HYPERFRAMES_NO_UPDATE_CHECK=1` 和 `HYPERFRAMES_NO_AUTO_INSTALL=1`:不去 npm 查新版本,也不在后台自己 `npm install` 升级(`packages/cli/src/utils/updateCheck.ts`、`autoUpdate.ts`)。VidRoom 只用锁文件里那一版;
- `HOME` / `USERPROFILE` 指到数据目录:不管遥测开没开,它都会在家目录下写 `.hyperframes/config.json`(里面有匿名 id 和最近的渲染记录);
- `TMPDIR` / `TEMP` / `TMP` 指到数据目录:Chrome 的临时配置目录、Windows 上的渲染工作目录都放在这里。

单测 `apps/host/test/motion-telemetry.test.ts` 直接断言上面这组变量;再用锁定版本的真 CLI 跑 `hyperframes telemetry status`,确认它自己报 `disabled`、来源 `HYPERFRAMES_NO_TELEMETRY`。这条命令本身不上报。

## 浏览器:chrome-headless-shell(Chrome for Testing)

开工前按合同核实了三件事,结论如下。

### ① HyperFrames 用什么浏览器、从哪下载、什么许可

- **npm 包**:发布的 `hyperframes` CLI 依赖 `puppeteer-core`(实装 25.12.0)和 `@puppeteer/browsers`(3.2.3),**不依赖 `puppeteer`**。所以装它时不会自动下载任何浏览器;`puppeteer` 的 postinstall 会下 Chrome,`puppeteer-core` 不会。仓里 `packages/engine`、`packages/producer` 的 package.json 虽然列了 `puppeteer`,但 CLI 打包后的代码先试 `import("puppeteer")`,失败再退回 `puppeteer-core`。VidRoom 的安装里没有 `puppeteer`,实际走的是 `puppeteer-core`。
- **用哪个浏览器**:第一次渲染时,HyperFrames 自己用 `@puppeteer/browsers` 下载 **chrome-headless-shell**,版本锁在 `152.0.7977.30`(源码 `packages/cli/src/browser/manager.ts` 的 `CHROME_VERSION`),存到 `~/.cache/hyperframes/chrome`。它**不校验 sha256**。解析顺序是:环境变量 `HYPERFRAMES_BROWSER_PATH` → 自己的缓存 → 系统装的 Chrome → 自动下载。
- **下载源**:Chrome for Testing 的公开存储桶 `https://storage.googleapis.com/chrome-for-testing-public/<版本>/<平台>/chrome-headless-shell-<平台>.zip`,也就是 `@puppeteer/browsers` 的默认地址。
- **许可**:这是 Google 用 Chromium 开源代码构建的二进制,`chrome-headless-shell --version` 报 `Google Chrome for Testing 152.0.7977.30`。压缩包里的 `LICENSE.headless_shell` 开头是 Chromium 的 BSD-3-Clause,后面依次列出各第三方组件的许可(约 3.4 万行)。`ABOUT` 文件写的是「Google Chrome … See the Terms of Service at chrome://terms」,也就是说**二进制本身属于 Google 的 Chrome 品牌构建,另受 Chrome 服务条款约束,不是纯粹的 BSD 软件**。VidRoom **不把它打进安装包**:用户第一次渲染时直接从 Google 的存储桶下载,和 Puppeteer 的默认做法一样。

VidRoom 的做法:**不让 HyperFrames 自己下载**。`apps/host/src/motion/browser.ts` 锁定同一版本 `152.0.7977.30`,Windows(win64)和 Linux(linux64)各记一条,大小和 sha256 都写死(2026-10-01 下载后本机计算,md5 与存储桶 `x-goog-hash` 响应头一致)。下载沿用第 3a 批 ComfyUI 便携包那套断点续传加 sha256 校验(`comfyui/download.ts`)。校验通过后解压到 `<数据目录>/runtime/chrome-headless-shell-<版本>/`,再用 `HYPERFRAMES_BROWSER_PATH` 把路径交给 HyperFrames。换镜像用 `VIDROOM_BROWSER_DOWNLOAD_URL`,校验照旧按清单。单测会对照 HyperFrames 包里写死的 `CHROME_VERSION`,确认两边版本一致,升级 HyperFrames 时会提醒一起改。

| 平台 | 文件 | 字节数 | sha256 |
|---|---|---|---|
| Windows | chrome-headless-shell-win64.zip | 119,527,247 | `5d7df999a6e4a65a1b16b25b61064f7337b8aa8ee2ed1b4e07bfdd24f6e4275e` |
| Linux | chrome-headless-shell-linux64.zip | 119,388,396 | `1b150320178ecabe39726bcf3198ebb896ba2b7a07d870db1710914c42d55221` |

### ② Puppeteer 能不能在 Host 进程里跑(`ELECTRON_RUN_AS_NODE=1`)

**能。** 桌面版的 Host 是 `ELECTRON_RUN_AS_NODE=1` 的 Electron 44.5.1(自带 Node 24.21.0)。在开发机(Linux)上实测了两条路径:

1. 最小验证脚本:在 `ELECTRON_RUN_AS_NODE=1 electron` 里 `import puppeteer-core`,`launch({ executablePath: chrome-headless-shell })`,开页、截图、关闭。输出 `runtime: { electron: '44.5.1', node: '24.21.0', runAsNode: '1' }`、`browser version: HeadlessChrome/152.0.7977.30`、`screenshot bytes: 2336`、`closed ok`。
2. 整条链路:e2e `motion` 项目设了 `VIDROOM_E2E_ELECTRON` 后,会用 `ELECTRON_RUN_AS_NODE=1 electron` 跑打包好的 `host.mjs`。聊一句「做一条10秒的开场动画」后得到 10.000000 秒的 MP4。

原理:Host 用 `process.execPath` 起 HyperFrames CLI,`ELECTRON_RUN_AS_NODE=1` 原样继承给子进程,所以 CLI 同样跑在「Electron 当 Node」里。CLI 再用 puppeteer-core 以普通子进程启动 chrome-headless-shell,双方通过 CDP 管道通信。这一步只用到 Node 的 `child_process` 和 socket/pipe,和 Electron 自己的浏览器能力无关。Windows 上的同一条路径由 CI 的 desktop 作业验证:静默安装后,用装好的 `VidRoom.exe` 跑安装包里的 `host.mjs`,调用安装包里的 HyperFrames。

### ③ 能不能直接用 Electron 自带的 Chromium,省掉一次下载

**不能,所以走「首次使用时下载」。** Electron 44.5.1 自带 Chromium 152.0.7977.130,和 HyperFrames 锁的 152.0.7977.30 同一个大版本,版本号不是问题,不能复用的原因在别处:

1. **Electron 可执行文件不是一个能被 Puppeteer 启动的浏览器。** 实测把 `executablePath` 指向 Electron 可执行文件:
   - 如果继承了 `ELECTRON_RUN_AS_NODE=1`,它会被当成 Node 启动,把 `--headless=new`、`--disable-extensions` 等浏览器参数全部当成 `bad option` 拒掉;
   - 去掉这个环境变量后,它把 Puppeteer 传的 `about:blank` 当成要加载的应用路径,报 `Unable to find Electron app at …/about:blank`。

   Electron 是「应用运行时」,不是可以独立启动的浏览器。
2. **HyperFrames 只会自己启动浏览器,不会连接已经在跑的浏览器。** 它的源码里没有 `puppeteer.connect` / `browserWSEndpoint` 这条路,唯一的入口是 `HYPERFRAMES_BROWSER_PATH`(一个可执行文件路径)。要让它借用 Electron 窗口,只能 fork 改它的代码。
3. **Host 进程里本来就没有 Chromium。** `ELECTRON_RUN_AS_NODE=1` 下 Electron 只是 Node,不带渲染能力。真要用 Electron 的 Chromium,只能回到主进程开 `--remote-debugging-port`,再让别的进程连进来。这等于给整个应用开一个本机调试口:同机的任何进程都能控制这个已经解密过 API key 的应用。这种安全代价不值得。
4. **确定性渲染依赖 headless-shell。** HyperFrames 最快、最稳定的截帧路径是 `HeadlessExperimental.beginFrame`,只有 chrome-headless-shell 支持。普通 Chrome/Chromium 只能退回截图模式。这一条是次要原因:VidRoom 现在出 png-sequence(带透明通道),实际走的也是截图模式(实测日志 `captureMode: screenshot`)。

代价:第一次渲染要多下载约 114 MB。之后放在数据目录里复用,换 VidRoom 版本也不用重下(除非锁定版本变了)。

## LLM 提供方 SDK(`@ai-sdk/*`)

| 项 | 值 |
|---|---|
| 是什么 | [vercel/ai](https://github.com/vercel/ai)(AI SDK):统一的模型调用层。`@ai-sdk/anthropic` 走 Anthropic 的 Messages API,`@ai-sdk/deepseek` 走 DeepSeek 的 API,`@ai-sdk/alibaba` 走阿里云百炼(通义万相生视频),`@ai-sdk/bytedance` 走火山方舟(Seedream 生图) |
| 版本 | `@ai-sdk/anthropic@4.0.70`(第 5 批新增)、`@ai-sdk/deepseek@3.0.57`(第 5 批之前就有)、`@ai-sdk/alibaba@2.0.60` 与 `@ai-sdk/bytedance@2.0.56`(第 6b 批新增),由 `pnpm-lock.yaml` 锁版本 |
| 许可 | 四个都是 Apache-2.0(2026-10-02 查 npm registry 元数据核实) |
| 怎么来 | `pnpm install`,与其它运行时依赖一样随应用打包分发,不单独下载、不跑安装脚本 |
| 怎么用 | `apps/host` 按用户选的提供方建模型实例,只用它发 HTTP 请求。不含任何模型权重,API key 由用户在设置里填、存 `safeStorage` |

## 云端生成服务(不自带、用户自带 key)

| 项 | 值 |
|---|---|
| 是什么 | 阿里云百炼(生视频,模型 `wan2.7-t2v`)与火山方舟(生图,模型 `seedream-5-0-260128`)。都是托管服务,不是本地组件 |
| 怎么来 | VidRoom **不分发、不代理、不代付**。用户自己在厂商控制台开账号拿 API key,填进设置页;key 加密存在本机,请求由 Host 从用户机器直连厂商 |
| 用在哪 | 本机显卡跑不动、或用户明说要用云端时;工具先估价、用户在页面上点确认才真花 |
| 价目 | 生视频 720p ¥0.60/秒、1080p ¥1.00/秒(阿里云百炼官网「视频生成(720P) 0.6 每秒」);生图 ¥0.22/张(火山方舟 Ark 价目页口径;另有「大模型接入」页作 ¥0.33,以 Ark 价目页为准) |
| 许可/条款 | 各自的服务条款约束生成内容所有权与使用范围,不在本仓管辖内;VidRoom 只负责把提示词发出去、把成片存进作品库 |

## 借鉴但没有引入代码的项目

- [tuzhechen2005/opus-video-skills](https://github.com/tuzhechen2005/opus-video-skills)(MIT):只借了「分镜 → 构建 → 审查 → 编码」这个流程顺序,代码是自己写的(`apps/host/src/motion/storyboard.ts`、`service.ts`)。
- [iart-ai/motion-skills](https://github.com/iart-ai/motion-skills)(MIT):只借了 `tools/verify` 的思路(冻帧检测、联系表、MP4 探测),代码是自己写的(`apps/host/src/motion/verify.ts`)。
