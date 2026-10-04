# VidRoom

一个 **DeepSeek Harness(dsh)插件**:把「本地出片 + 工作流库 + 全中文」带进 dsh。

一句话主题 → 交给你自己机器上的 ComfyUI(用 MiniMax H3 模型)出一段短视频;另有一个工作流库面板,
能列出内置工作流、读 SKILL.md 原文、填主题点运行。桌面壳、ComfyUI 的起停、聊天会话全部交给 dsh,这个仓只做插件。

插件本体在 [`apps/dsh-vidroom`](apps/dsh-vidroom/),用法、工具、配置、工作流格式都在那份 [README](apps/dsh-vidroom/README.md) 里。

## 装

```bash
git clone https://github.com/Davids-G1t/VidRoom.git
cd VidRoom
corepack pnpm install
corepack pnpm --filter dsh-vidroom build      # 产出 lib/ 与 client/client.js
dsh plugin --profile desktop add "$PWD/apps/dsh-vidroom"
```

换成你在用的 profile(`desktop` / `web`)后重启 dsh:那边会多出 VidRoom 面板入口与两个 Agent 工具
(`vidroom_generate` / `vidroom_workflows`)。`dsh plugin --profile <profile> remove dsh-vidroom` 卸掉。

## 生成不在本仓

真正的视频生成全部跑在 [ComfyUI](https://github.com/Comfy-Org/ComfyUI)(GPL-3.0)里:它作为独立进程运行,
插件只通过它自带的 HTTP API 提交工作流、轮询、取回产物。ComfyUI 与模型权重都**不随本仓分发**,
也不进这个仓的源码树;插件不对局域网开放任何端口,自己也不联网。

插件因此可以保持 Apache-2.0,不受 ComfyUI 的 GPL-3.0 传染 —— **这是常见做法,不是法律意见**,
采用的是 [SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI)、[Krita AI Diffusion](https://github.com/Acly/krita-ai-diffusion) 等项目的先例。
MiniMax H3 模型本身的使用限制见 [docs/USE-POLICY.md](docs/USE-POLICY.md)。

## 许可

插件 [Apache-2.0](LICENSE)。插件的源码树里**不包含任何第三方二进制**:既没有 ComfyUI,也没有 ffmpeg、
模型权重或浏览器内核。`docs/third-party.md` 记录的是已经归档的独立 app 当年打包与下载过的东西(见下),留档备查。

## 开发

pnpm 单仓,目前只有一个包 `apps/dsh-vidroom`(TypeScript,宿主半边 `src/`,网页面板半边 `src/client/`)。

```bash
corepack pnpm install
corepack pnpm test          # 所有包的单元测试(vitest)
corepack pnpm typecheck     # 宿主半边 + 面板半边两套 tsconfig
corepack pnpm build         # 打 lib/(宿主)与 client/client.js(面板)
```

测试不需要显卡、不需要 ComfyUI、不联网:集成用例自己起一个**假 ComfyUI**(真 HTTP 服务,按真机形状答
`/system_stats`、`/prompt`、`/history/<id>`、`/view`),插件这一侧(客户端、runtime、路由、工具)全是真的,
钉住「提交 → 产出」这条链。真机上要验出片,需要一台显存 ≥ 24 GiB 的 NVIDIA 机器加已配好的 ComfyUI 与 H3 权重。

## 旧 app 去哪了

2026-10-04 起本仓的形态从「独立 Windows app(Node Host + React 网页 + Electron 壳)」改成 dsh 插件,
旧的三个包与它那套 Playwright e2e 已从 main 删掉,留档在 tag **`legacy-app-final`**:

```bash
git checkout legacy-app-final    # 旧 app 的完整源码与文档都在这里
```

`docs/decisions.md` 是一直沿用的裁决记录;`docs/USE-POLICY.md`(H3 使用限制)对插件仍然适用;
`docs/third-party.md` 是归档 app 的第三方组件核查表。
