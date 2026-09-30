# VidRoom

面向普通 Windows 用户的本地 AI 视频个人工坊:装一个 exe,跟 AI 聊天,在自己的 NVIDIA 显卡上出片。云端生成 API 只做可选(BYOK,自带密钥)。

## 生成在 ComfyUI,不是本仓

VidRoom **不自己写生成引擎**。真正的视频/图像生成全部跑在 [ComfyUI](https://github.com/Comfy-Org/ComfyUI)(GPL-3.0)里:
- ComfyUI 作为**独立进程**运行,由本仓的 Node Host 在首次启动时从官方 Release 下载,经它自带的 HTTP/WebSocket API 驱动。
- ComfyUI **不随本仓的安装包分发**,也不进这个仓库的源码树。
- 普通用户默认看不到 ComfyUI 的节点图,只看到聊天界面;高级用户可以一键打开 ComfyUI 自己的网页(只监听 `127.0.0.1`,不对局域网开放)。

这样,VidRoom 主程序可以保持 Apache-2.0,不受 ComfyUI 的 GPL-3.0 传染 —— **这是常见做法,不是法律意见**,采用的是 [SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI)、[Krita AI Diffusion](https://github.com/Acly/krita-ai-diffusion) 等项目的先例。

## 许可

主程序 [Apache-2.0](LICENSE)。ComfyUI 及其驱动的模型各自遵循自己的许可,详见运行时的许可提示(如 MiniMax H3 的社区协议)。

## 状态

重启中。详见 [docs/decisions.md](docs/decisions.md)。

## 开发

pnpm 单仓:`apps/host`(TypeScript Node Host,只听 `127.0.0.1`)+ `apps/web`(React + Vite 聊天页)。

```bash
pnpm install
pnpm build                  # 构建聊天页到 apps/web/dist
pnpm start                  # 起 Host,控制台打印一次性「启动地址」,用浏览器打开它
pnpm test                   # 两个包的单元测试
pnpm test:e2e               # Playwright:不给 key 的页面行为(CI 也跑)
pnpm test:e2e:gpu           # Playwright:真显卡 + 真 DeepSeek key,只在开发机跑
```

- 聊天 LLM 第一期走云端 DeepSeek(BYOK)。key **只从文件读**:环境变量 `VIDROOM_DEEPSEEK_KEY_FILE` 给出文件路径;不设或文件不存在时聊天不可用,页面提示去设置。
- 鉴权:Host 启动时打印 `http://127.0.0.1:<端口>/launch?token=<一次性 token>`;打开后换成 HttpOnly 的 session cookie,token 立即作废。所有 `/api/*` 都要这个 cookie,否则 401。
- 显卡探测:agent 工具 `probe_gpu` 跑 `nvidia-smi`,按显存分档 —— 没有 NVIDIA 显卡 `none`;< 15 GiB `unsupported`;15–24 GiB `experimental`(MiniMax H3 可用、默认关);≥ 24 GiB `default`。显存按整 GiB 四舍五入后比较(标称 24GB 的卡实报常略少于 24576 MiB)。
- 端口默认随机,可用 `VIDROOM_PORT` 固定。
