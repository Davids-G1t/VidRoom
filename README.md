# VidRoom

面向普通 Windows 用户的本地 AI 视频个人工坊:装一个 exe,跟 AI 聊天,在自己的 NVIDIA 显卡上出片。云端生成 API 只做可选(BYOK,自带密钥)。

## 生成在 ComfyUI,不是本仓

VidRoom **不自己写生成引擎**。真正的视频/图像生成全部跑在 [ComfyUI](https://github.com/Comfy-Org/ComfyUI)(GPL-3.0)里:
- ComfyUI 作为**独立进程**运行,由本仓的 Node Host 在首次启动时从官方 Release 下载,经它自带的 HTTP/WebSocket API 驱动。
- ComfyUI **不随本仓的安装包分发**,也不进这个仓库的源码树。
- 普通用户默认看不到 ComfyUI 的节点图,只看到聊天界面;高级用户可以一键打开 ComfyUI 自己的网页(只监听 `127.0.0.1`,不对局域网开放)。

这样,VidRoom 主程序可以保持 Apache-2.0,不受 ComfyUI 的 GPL-3.0 传染 —— **这是常见做法,不是法律意见**,采用的是 [SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI)、[Krita AI Diffusion](https://github.com/Acly/krita-ai-diffusion) 等项目的先例。

## 许可

主程序 [Apache-2.0](LICENSE)。ComfyUI 及其驱动的模型各自遵循自己的许可,详见运行时的许可提示(如 MiniMax H3 的社区协议)。剪辑用的 ffmpeg 是首次使用时从 [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) 下载的 **LGPL** 构建(不带 GPL 的 libx264,H.264 编码用 BSD 许可的 OpenH264),作为独立可执行文件调用,不链接进主程序。**注意**:思科(Cisco)对 OpenH264 的专利授权只覆盖思科自己分发的二进制([openh264.org FAQ](https://www.openh264.org/faq.html)),这份构建是从源码编译的,不带这项专利授权——这不影响它"不是 GPL"的结论,但涉及 H.264 专利的商业使用要自行评估。

## 状态

重启中。详见 [docs/decisions.md](docs/decisions.md)。

## 开发

pnpm 单仓:`apps/host`(TypeScript Node Host,只听 `127.0.0.1`)+ `apps/web`(React + Vite 聊天页)+ `apps/desktop`(Electron 壳,打 Windows 安装包)。

```bash
pnpm install
pnpm build                  # 构建聊天页到 apps/web/dist,并打桌面版主进程与 Host 单文件
pnpm start                  # 起 Host,控制台打印一次性「启动地址」,用浏览器打开它
pnpm desktop                # 起桌面版(开发模式)
pnpm test                   # 三个包的单元测试
pnpm test:e2e               # Playwright:不给 key 的页面行为(CI 也跑)
pnpm test:e2e:gpu           # Playwright:真显卡 + 真 DeepSeek key,只在开发机跑
pnpm test:e2e:desktop       # Playwright 驱动桌面版:假 key + 假 LLM 服务(CI 上驱动静默安装好的 exe)
pnpm test:e2e:comfyui       # Playwright:「启动 / 打开 ComfyUI」,默认假 ComfyUI;设了 VIDROOM_COMFYUI_DIR 就用真的
pnpm comfyui:smoke          # 真 ComfyUI 起停冒烟(参数见 apps/host/scripts/comfyui-smoke.ts)
pnpm dist:win               # 打 Windows 安装包 VidRoom-Setup-<版本>.exe(CI 在 windows-latest 上打)
```

- 聊天 LLM 第一期走云端 DeepSeek(BYOK)。桌面版在设置页填 key;命令行起 Host 时 key **只从文件读**:环境变量 `VIDROOM_DEEPSEEK_KEY_FILE` 给出文件路径;不设或文件不存在时聊天不可用,页面提示去设置。
- 鉴权:Host 启动时打印 `http://127.0.0.1:<端口>/launch?token=<一次性 token>`;打开后换成 HttpOnly 的 session cookie,token 立即作废。所有 `/api/*` 都要这个 cookie,否则 401。
- 显卡探测:agent 工具 `probe_gpu` 跑 `nvidia-smi`,按显存分档 —— 没有 NVIDIA 显卡 `none`;< 15 GiB `unsupported`;15–24 GiB `experimental`(MiniMax H3 可用、默认关);≥ 24 GiB `default`。显存按整 GiB 四舍五入后比较(标称 24GB 的卡实报常略少于 24576 MiB)。
- 端口默认随机,可用 `VIDROOM_PORT` 固定。

ComfyUI(`apps/host/src/comfyui/`,页面上点「启动 ComfyUI」时才找/下载/起):
- **Windows**:首次使用时下载官方 NVIDIA 便携包 `ComfyUI_windows_portable_nvidia.7z`(v0.38.0;版本、大小、sha256 写死在 `manifest.ts`,运行时不向远端要清单),断点续传(HTTP Range),sha256 对不上删掉重下,用随包的 7za 解压到 `%LOCALAPPDATA%\VidRoom\runtime\`。换镜像:环境变量 `VIDROOM_COMFYUI_DOWNLOAD_URL` 给完整下载地址,校验照旧按清单。
- **Linux**:不下载。环境变量 `VIDROOM_COMFYUI_DIR` 指向已装好的 ComfyUI(有 `main.py` 的目录),python 默认用目录下的 `venv/`、`.venv/`,或用 `VIDROOM_COMFYUI_PYTHON` 指定。
- 其它环境变量:`VIDROOM_COMFYUI_ARGS`(给 ComfyUI 加参数,如 `--cpu`)、`VIDROOM_DATA_DIR`(数据目录)。
- Host 把 ComfyUI 当子进程起停:`--listen 127.0.0.1`、端口每次取一个空闲的、`--disable-auto-launch`;轮询 `/system_stats` 到就绪;检查 ComfyUI ≥ 0.30.0、PyTorch CUDA ≥ 13.0。「打开 ComfyUI」在系统默认浏览器里开 `http://127.0.0.1:<端口>/`。
- 停止:ComfyUI 没有关闭服务的 HTTP 接口,它的正常退出路径是 Ctrl+C。Linux 上给进程组发 SIGINT,10 秒不退再 SIGKILL;Windows 上没有信号可发(Node 的 `kill()` 就是强杀),改为关 stdin 让 ComfyUI 进程里的引导代码模拟 Ctrl+C,10 秒不退再 `taskkill /T /F`。Host 这样主动退出、或被 CLI 强杀时,ComfyUI 发现 stdin 断了会走这条路自己退出。Windows 桌面版走的是另一条路:Electron 退出时连带强杀 ComfyUI 所在的 Windows 作业对象,更快、不经过 stdin 检测,同样不留孤儿,但不是「优雅退出」,是直接强杀(细节见 `apps/host/src/comfyui/process.ts` 顶部注释)。

出片(MiniMax H3,`apps/host/src/h3/`):
- 页面上点「出片」:第一次先弹许可同意页(中文摘要 + [许可全文](apps/web/public/licenses/MiniMax-H3-LICENSE.txt)),勾选同意才下载;同意记录(许可文件 sha256 + 同意时间)存在数据目录的 `h3-consent.json`。之后补齐四个权重(清单与 HF API 核对的 size/sha256 在 `models.ts`,钉在 HF commit 上),本地已有且 sha256 对得上的跳过。模型目录 `VIDROOM_MODELS_DIR`(默认 `<数据目录>/models`),经 `--extra-model-paths-config` 告诉 ComfyUI;换镜像 `VIDROOM_H3_DOWNLOAD_BASE`。命令行核对/补齐:`pnpm --filter @vidroom/host h3:models [-- --download]`。
- 在聊天里说想要什么视频,助手调 `generate_video`:自己写 180–260 词英文提示词,时长按 24 fps 吸附到 17k+5 帧;工作流是锁定 commit 的官方模板 `video_minimax_h3_t2v.json` 转成的 API 格式(`workflows/h3-t2v.json`,来源写在文件里);进度从 ComfyUI 的 WebSocket 转到聊天页;成片进作品库(`<数据目录>/library/videos.json` + MP4),MP4 元数据写 `AI-generated with MiniMax H3`。
- 准入:显存 ≥24 GiB 默认允许;15–24 GiB 要设 `VIDROOM_H3_EXPERIMENTAL=1`;更低或没有 NVIDIA 显卡不允许。
- Windows 内存护栏:ComfyUI 放进作业对象(Job Object),整组内存超上限只结束 ComfyUI(退出码 87),Host 不受影响;上限默认「物理内存 − 4 GiB」,`VIDROOM_COMFYUI_MEMORY_LIMIT_MB` 可改(0 = 不设)。
- 许可义务:成片卡片、详情页、「关于」页标「MiniMax H3」,「关于」页附 NOTICE 原文;使用限制原样转达见 [docs/USE-POLICY.md](docs/USE-POLICY.md);滥用举报流程见 [docs/abuse.md](docs/abuse.md)(菜单「举报滥用」打开 issue 模板)。防滥用靠聊天 LLM 按系统提示词判断意图,不做关键词过滤。仓库里不放任何成片或截帧。
- 测试:`pnpm test:e2e:h3`(开发机:假 ComfyUI 回放全链路,不碰真实权重、不需要真显卡,测试自己起本机假镜像)、`pnpm test:e2e:abuse`(开发机:真 DeepSeek 的滥用测试,要 `VIDROOM_DEEPSEEK_KEY_FILE`)。
- 已知问题:权重下载走 Node 的 `fetch`,默认不读系统代理环境变量;连不上 Hugging Face 时(常见于国内网络)要设 `NODE_USE_ENV_PROXY=1` 才会走代理,应用目前不会自动提示这一点,用户会看到下载失败但不知道原因——留给后续批次处理(比如下载失败时给出更明确的排障提示)。

剪辑(`apps/host/src/ffmpeg/`):
- agent 工具 `list_videos`、`trim_video`、`concat_videos`、`add_subtitle`,只按作品库 id 操作,结果作为新的一条入库(记 `editedFrom`),原片不动;容器元数据(含 `AI-generated with MiniMax H3`)从第一个输入带过来。
- ffmpeg:Windows / Linux 都在第一次剪辑时按 `manifest.ts` 下载锁定的 LGPL 构建(版本、大小、sha256 写死,断点续传,解压到 `<数据目录>/runtime/`),**不用系统自带的 ffmpeg**;装好后查 `ffmpeg -version` 的 configuration 行,带 `--enable-gpl` 就拒用。换镜像 `VIDROOM_FFMPEG_DOWNLOAD_URL`;命令行预下载 `pnpm ffmpeg:fetch`。
- 剪切:起点在关键帧上就 `-c copy` 流复制;不在就用 libopenh264 重新编码,剪得准但慢。拼接:各段编码参数一致用 concat demuxer 流复制,不一致用 concat 滤镜统一成第一段的尺寸/帧率后重新编码(没声音的段补静音)。加字幕:`drawtext` 烧进画面,libopenh264 重新编码;字体按平台找带中文字形的系统字体(Windows 微软雅黑/黑体/宋体,Linux Noto CJK/文泉驿),`VIDROOM_SUBTITLE_FONT` 可指定。
- 测试素材由 ffmpeg 的 `color`/`testsrc`/`sine` 现做(几百 KB),放 `apps/host/.test-tmp/`(`VIDROOM_TEST_TMP` 可改),不用系统临时目录。

桌面版(`apps/desktop`):
- 页面从 `vidroom-app://app/` 加载,开 `sandbox`、`contextIsolation`,关 `nodeIntegration`;每个 IPC 调用先核来源(必须是本应用的顶层页面),不是就拒绝并记日志。
- Host 是主进程用 `ELECTRON_RUN_AS_NODE=1` fork 出来的子进程(复用 Electron 自带的 Node)。页面的 `/api` 请求由协议处理器带上 session cookie 转发给 Host,页面看不到启动地址和 cookie。
- 设置页填的 DeepSeek key 用 Electron `safeStorage`(Windows 上走 DPAPI)加密,存到用户数据目录的 `deepseek-key.enc`;启动时主进程解密,经 fork 的 IPC 通道交给 Host,不进环境变量和命令行参数。页面只能「设置新 key」和「问有没有 key」,拿不到明文也拿不到密文。
- 关窗时有聊天请求在进行就先问;退出时连带结束 Host(Host 也会在父进程断开时自己退出)。
- 安装包:未签名 NSIS,`oneClick: false`、`perMachine: false`,静默安装(`/S`)默认装进 `%LOCALAPPDATA%\Programs\VidRoom`,只写 HKCU。
