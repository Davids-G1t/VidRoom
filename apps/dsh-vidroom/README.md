# dsh-vidroom

把「本地出片 + 工作流库 + 全中文」带进 DeepSeek Harness(dsh)的一个插件。

桌面壳、ComfyUI 的起停、聊天会话全交给宿主;这个插件只做 VidRoom 那一小块:
**一句话主题 → 交给本地 ComfyUI 上的 MiniMax H3 出一条短视频**,外加一个能列出、能读原文、能点运行的工作流库面板。
第 2 批又接上一条**复刻链**:本地参考片 → 工程文件 → 算好的计划 → 本机出候选 → 校订词时序 → 合成成片。

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
| `vidroom_h3` | H3 适配面:`capabilities` 给参数域/工作流哈希/本机就绪、`run` 按显式参数跑一次、`status` 按 promptId 查真实状态 | `action`、`prompt`、`width`、`height`、`frames`、`fps`、`seed`、`promptId` |
| `vidroom_reference` | 登记本地参考片并抽切镜候选(只读本机文件) | `localPath`、`projectPath`、`referenceUrl` |
| `vidroom_project` | 看/改工程:`inspect`、`patch`(白名单 JSON Patch)、`create` | `projectPath`、`action`、`baseHash`、`patch` |
| `vidroom_plan` | 只算不做:施工图、复用与新生成条数、估算、预算与缺项 | `projectPath`、`target`、`budget` |
| `vidroom_render` | 按冻结的计划真跑:`generate-missing` 出候选、`compose` 合成 | `projectPath`、`mode`、`planHash`、`expectedProjectHash` |
| `vidroom_job` | 查运行回执(状态、逐镜头结果、产物、校验、日志) | `projectPath`、`runId` |
| `vidroom_candidates` / `vidroom_assets` | 列候选 / 列依赖素材与缺件 | `projectPath`、`shotId`、`cursor`、`limit` |
| `vidroom_align_words` | 人工校订一段配音的词时序,并编译字幕/特效 | `segmentId`、`assetId`、`audioHash`、`scriptHash`、`wordWindows` |
| `vidroom_variants` | 一次调用批量做变体(先 `plan` 再 `run`) | `variants`、`action`、`target`、`budget`、`planHash` |
| `vidroom_import_asset` / `vidroom_candidate_add` | 把本机文件登记成工程资产 / 手工登记一条已有候选 | `projectPath`、`sourcePath`、`shotId`、`assetId` |

两个工具都**只回路径与元数据,不回灌二进制**;产物地址是 ComfyUI 的 `/view` 播放链接,
面板靠它放播放器,agent 靠它给用户看。

参数默认值:`seconds=5`、`megapixels=0.4`、`aspect=16:9`(16:9 下 0.4MP = 864×480,0.7MP = 1152×640)。
帧数按 H3 的 **17k+5** 网格吸附(5、22、39……362):说 5 秒得到 124 帧,说 7 秒得到 175 帧(7.29 秒),
算出来的帧数不在网格上会被吸附到最近的一格,而不是原样提交(原样提交会被 ComfyUI 拒)。

## 第 2 批:复刻一条爆款(工程文件驱动)

链路:**本地参考片 → 工程文件(`project.vr.json`)→ plan → 本机 H3 出候选 → 选定 + 校订词时序 → 合成 → 回执**。

- 工程文件是唯一的真身:`schemaVersion: "vr.project/1"` 的 UTF-8 JSON,同目录 `assets/` 放本地素材,
  `runs/<runId>/` 放工程快照、`plan.json`、`compose.sh`、`final.mp4` 与 `receipt.json`(运行回执不允许被事后改写)。
- 路径一律相对工程根,禁 URL、绝对路径、`..` 与符号链接越界;导入的素材复制进 `assets/` 并算 sha256;
  参考链接只当文字存档(只给链接会回 `REFERENCE_LOCAL_REQUIRED`,不会去下载)。
- **plan 不生成、不下载**:只出 DAG、复用/新生成条数、请求帧数与实际参数、预算和缺项。估算只用本机实测校准;
  没校准就写 `null` 而不是编一个数。估值与实跑对不上的原因写在回执的 `checks` 里。
- **compose 阶段一次 ComfyUI 请求都不发**(回执里 `checks.comfySubmissions = 0`);只改样式的变体,新增生成数也是 0。
  两条镜头写同一段文案时,同一个配方只投一次,两边共用同一个 asset。
- 词锚:字幕/特效挂在稳定 `tokenId` 的词首/尾锚上,秒数只给人看。删了被引用的词、换了音轨或裁切/语速,
  旧对齐即失效,回 `ALIGNMENT_REQUIRED`,不会拿旧窗口顶。
- 边界:**自用、不传播、不商用**。不抓平台参考片,不上传/分享/发布任何内容,不调云端模型理解参考片,
  不引入 ASR/OCR/VLM/TTS 模型(转写与词时序首版人工录入/校订),只连本机回环地址。

更细的一步步走法与错误码表在 `references/batch2-pipeline.md`(技能里点名才读那份)。

### 对第 1 批的三条变更申请(R1–R3)现状

| 申请 | 落地情况 |
| --- | --- |
| **R1 可检查、可重放的 H3 底座** | 已落:`vidroom_h3` 的 `capabilities` 给参数域/工作流 id 与哈希/本机就绪与缺什么;`run` 按显式参数跑并把参数快照与实测值一起带回;`status` 按 promptId 查真实状态。不支持的种子/尺寸/帧数回 `UNSUPPORTED_PARAMS`,不静默忽略。原 `vidroom_generate` 签名与行为未改。 |
| **R2 带出处的本地素材与剪辑底座** | 已落:`vidroom_assets` 列资产(绝对路径 + 缺件)、`vidroom_import_asset` 登记外部文件、`vidroom_candidate_add` 手工登记候选;生成素材立刻取回并复制进 `assets/` 并登记 sha256,不靠 ComfyUI 内存历史复跑。第 1 批的 runner 未重写;镜头候选索引、词锚编译与工程渲染都在第 2 批(`compose.ts` / `align.ts`)。 |
| **R3 本地执行与恢复** | 已落:只连回环地址、拒重定向到外网、路径/哈希/模型在执行端校验;job 状态为 `queued/running/succeeded/failed/cancelled`,工程 run 另有 `awaiting-selection/awaiting-alignment`;按 promptId 查既有任务(未知状态如实报待核,不自动重投);缺 ffmpeg/权重不自动下载;H3 的准入与「AI-generated with MiniMax H3」标名照旧。 |

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
| `projectsRoot` | `~/VidRoom/projects` | 不给 `projectPath` 时新工程落哪(第 2 批) |

显存准入:≥24 GiB 默认放行;15–24 GiB 算实验档,要显式开 `allowExperimental` 才放行;
不到 15 GiB 直接不放行。档位不合适时错误信息里会写清是显存不够还是没开实验档 —— 不会闷头跑,也不会假装能跑。

## 它不做什么

不做云端出片与自带 key(那部分随旧 VidRoom app 一起归档);不做独立壳、独立安装包、自动更新;
不管多用户与多租户。不做自动抓平台参考片,不做任何内容外发/上传/分享/发布。
ComfyUI 起停、模型下载、聊天会话都在宿主那边。

## 许可

Apache-2.0。内置的 H3 工作流 JSON 与提示词要点来自本仓自己的旧 app(同许可);
不包含任何第三方闭源代码。H3 权重与 ComfyUI 各自按它们自己的许可使用。
