# dsh-vidroom

把「本地出片 + 工作流库 + 全中文」带进 DeepSeek Harness(dsh)的一个插件。

桌面壳、ComfyUI 的起停、聊天会话全交给宿主;这个插件只做 VidRoom 那一小块:
**一句话主题 → 交给本地 ComfyUI 上的 MiniMax H3 出一条短视频**,外加一个能列出、能读原文、能点运行的工作流库面板。

生成用的显卡、ComfyUI 与 H3 权重都在你自己的机器上:插件只连你配置的那个 ComfyUI 地址(`baseUrl`),
不访问任何第三方云端、不上传素材、不带任何密钥。

## 装

```bash
corepack pnpm install            # 在本仓根目录:给插件包自己装上依赖
corepack pnpm --filter dsh-vidroom build

dsh plugin --profile <profile> add /path/to/VidRoom/apps/dsh-vidroom
```

`<profile>` 换成你在用的那份(`desktop` / `web`)。装完重启 dsh:桌面端会多一个 VidRoom 面板入口,
Agent 那边多出两个工具(见下)。卸:

```bash
dsh plugin --profile <profile> remove dsh-vidroom
```

两点实测过的注意:

- **插件目录要先装过依赖**(上面那句 `pnpm install` 就是干这个的)。`dsh plugin add <目录>` 走的是 pnpm 的
  `link:` 装法,它**不会**替你把被链过去的包的依赖装一遍;目录里没有 `node_modules` 时,dsh 重启后会报
  「failed to import」而插件静默不工作。
- 不想从目录装,也可以先 `corepack pnpm pack` 打出 `dsh-vidroom-<版本>.tgz`,再
  `dsh plugin --profile <profile> add <tgz 的路径>`(打包会自动先构建,`prepack` 脚本负责)。

## Agent 拿到什么

| 工具 | 干什么 | 主要参数 |
| --- | --- | --- |
| `vidroom_generate` | 一句话主题直接出片,等到产物落地才返回 | `prompt`(或 `topic`)、`seconds`、`megapixels`、`aspect`、`seed` |
| `vidroom_workflows` | 工作流库:`list` 列、`read` 读 SKILL.md 原文、`run` 按工作流跑 | `action`、`slug`、`topic` |

两个工具都**只回路径与元数据,不回灌二进制**;产物地址是 ComfyUI 的 `/view` 播放链接,
面板靠它放播放器,agent 靠它给用户看。

参数默认值:`seconds=5`、`megapixels=0.4`、`aspect=16:9`(16:9 下 0.4MP = 864×480,0.7MP = 1152×640)。
帧数按 H3 的 **17k+5** 网格吸附(5、22、39……362):说 5 秒得到 124 帧,说 7 秒得到 175 帧(7.29 秒),
算出来的帧数不在网格上会被吸附到最近的一格,而不是原样提交(原样提交会被 ComfyUI 拒)。

## 面板

侧栏 VidRoom 面板里能:看当前连的 ComfyUI 地址与这台机器的显存/准入档位、列内置工作流、
展开 SKILL.md 原文、填主题与档位点运行、看这一轮每一步的进度与产物播放器。

## 工作流库

一份工作流 = `workflows/<slug>/SKILL.md`:frontmatter 写元信息,**正文里一个 ```workflow 代码块**写步骤:

````markdown
---
name: two-shots
title: 两镜拼接
description: 一句主题 → 两个镜头
---

正文是给人和 agent 读的说明:这条工作流干什么、什么时候用。

```workflow
steps:
  - id: first
    tool: generate_video
    args: { prompt: "{{topic}},自然光,浅景深", seconds: 5, megapixels: 0.4, aspect: "16:9" }
  - id: second
    tool: generate_video
    each: "{{first.outputs}}"
    args: { prompt: "接在 {{item.filename}} 后面再走一步的镜头" }
```
````

- 目录名(slug)必须**等于** frontmatter 里的 `name`;缺 `name`、缺 ```workflow 代码块、步骤里写不认识的字
  都在解析时报错,不会静默跳过。`builtin: true` 标记它是随包发的那几份。
- `{{topic}}` 拿到用户给的主题;`{{<步骤id>.outputs}}` 拿到那一步的全部产物(配 `each` 展开),
  `{{<步骤id>.ids}}` 拿到全部 prompt id,`{{<步骤id>.url}}` / `.filename` 拿到第一个产物。
- 这一批只实现 `generate_video` 一种步骤;写别的 tool 会在解析/执行时报错,不会静默跳过。
- 仓库里的 `workflows/h3-t2v`(横屏)与 `workflows/h3-t2v-vertical`(竖屏)是内置的两份;
  `h3-t2v.json` 是 H3 的 ComfyUI 工作流图,插件往上填四处:提示词、帧数、宽高、种子。

## 配置

`dsh` 配置里这一段(插件 id `vidroom`):

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `timeoutMs` | `900000` | 一段视频的等待预算(毫秒,30000–3600000);H3 七秒片在 5080 上要几分钟 |
| `pollIntervalMs` | `1000` | 等产物时的轮询间隔(毫秒,200–10000) |
| `allowExperimental` | `false` | 显存 15–24 GiB 时是否放行(见下) |

显存准入:≥24 GiB 默认放行;15–24 GiB 算实验档,要显式开 `allowExperimental` 才放行;
不到 15 GiB 直接不放行。档位不合适时错误信息里会写清是显存不够还是没开实验档 —— 不会闷头跑,也不会假装能跑。

## 它不做什么

不做云端出片与自带 key(那部分随旧 VidRoom app 一起归档);不做复刻爆款(第 2 批);
不做独立壳、独立安装包、自动更新;不管多用户与多租户。ComfyUI 起停、模型下载、聊天会话都在宿主那边。

## 许可

Apache-2.0。内置的 H3 工作流 JSON 与提示词要点来自本仓自己的旧 app(同许可);
不包含任何第三方闭源代码。H3 权重与 ComfyUI 各自按它们自己的许可使用。
