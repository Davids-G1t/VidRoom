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
