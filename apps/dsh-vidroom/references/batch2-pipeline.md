# 复刻一条爆款:工程链路逐步说明

这份是 `dsh-vidroom` 的**第三级**材料(列表一行摘要 → 技能正文 → 这里):模型只在真的要一步步走链路时读它,
日常出片不需要。全部动作都在本机,没有任何上传、下载、分享入口。

## 工程文件长什么样

一个工程 = 一个目录:

```
<工程目录>/
  project.vr.json          # schemaVersion: "vr.project/1",唯一的真身
  assets/                  # 导入/生成的本地素材(相对路径 + sha256)
  runs/<runId>/
    project.vr.json        # 这次 run 的工程快照(开工前那份,可重跑的输入)
    plan.json              # 冻结的计划(planHash 就在里面)
    compose.sh             # 合成时真正跑的那条 ffmpeg 命令(可手敲复现)
    final.mp4              # target=final 跑成的片子
    receipt.json           # 运行回执:状态、逐镜头结果、产物 sha256、校验、日志
```

规矩:路径一律相对工程根,禁 URL、禁绝对路径、禁 `..` 与符号链接越界;输入文件导入时复制进 `assets/` 并算 sha256。

## 一次完整闭环(工具调用顺序)

```jsonc
// ① 登记本地参考片(链接只作文字存档;只给链接会回 REFERENCE_LOCAL_REQUIRED)
{ "tool": "vidroom_reference", "localPath": "/abs/path/ref.mp4", "projectPath": "/abs/path/proj" }
// → { projectPath, assetId, probe, shotCandidates, analysisStatus: "draft", requiredAnnotations }

// ② 人工确认参考分析:景别/节奏/字幕版式/音色都是人工录入,写进 analysis
{ "tool": "vidroom_project", "action": "patch", "projectPath": "/abs/path/proj",
  "baseHash": "<inspect 给的 projectHash>",
  "patch": [ { "op": "replace", "path": "analysis.shots[shot-1].description", "value": "中景,推镜" } ] }

// ③ 目标镜头与文案改好以后,先算:要出几条、大概多久、占多少盘
{ "tool": "vidroom_plan", "projectPath": "/abs/path/proj", "target": "candidates" }
// → { planHash, projectHash, dag, reuseCandidateIds, newRequests, estimates, budget, blockers, ready }

// ④ 出候选(本机 GPU 串行;同一个配方只投一次,多条镜头写同一段文案会共用同一个 asset)
{ "tool": "vidroom_render", "projectPath": "/abs/path/proj", "mode": "generate-missing",
  "planHash": "<上一步的 planHash>" }
// → { runId, … };进度与回执用 vidroom_job 查

// ⑤ 选定候选 + 校订词时序(要先有音轨资产)
{ "tool": "vidroom_project", "action": "patch", "projectPath": "/abs/path/proj",
  "patch": [ { "op": "replace", "path": "shots[shot-1].selectedCandidateId", "value": "cand-1" } ] }
{ "tool": "vidroom_align_words", "projectPath": "/abs/path/proj", "segmentId": "seg-1",
  "assetId": "asset-9", "audioHash": "<音轨 sha256>", "scriptHash": "<当前 script 哈希>",
  "wordWindows": [ { "tokenId": "tok-1", "startFrame": 0, "endFrame": 19 } ] }

// ⑥ 合成(复用已选定素材,一条 ComfyUI 请求都不发)
{ "tool": "vidroom_plan", "projectPath": "/abs/path/proj", "target": "final" }
{ "tool": "vidroom_render", "projectPath": "/abs/path/proj", "mode": "compose", "planHash": "…" }
// 成片:runs/<runId>/final.mp4;回执里 checks.comfySubmissions = 0
```

批量试风格:`vidroom_variants` 先 `action: "plan"` 看每条要出几条新请求,再 `action: "run"` 真跑。
变体只准改白名单里的东西(文案、提示词、种子、显式选定的候选、样式);只改样式时新生成数 = 0。

## patch 的路径写法

两种都认,指同一处:

- 带 id 的段式:`shots[shot-1].generation.prompt`、`styles[style-1].color`
- JSON Pointer 式:`/shots/0/edit/speed`

只能改白名单字段(文案、提示词、fps/尺寸、种子、`edit`、`selectedCandidateId`、样式、锚点/字幕/特效、预算等);
写别的路径会回 `PATCH_REJECTED`,不会静默忽略。改了词/音轨/裁切/语速会让已有词锚作废 —— 这时工程会要求
重新对齐(回 `ALIGNMENT_REQUIRED`),旧秒数不会被拿来顶。

## 出错时看 code

| code | 什么时候 | 怎么办 |
| --- | --- | --- |
| `REFERENCE_LOCAL_REQUIRED` | 登记参考时只给了链接 | 先把参考片落到本机再登记 |
| `PROJECT_NOT_FOUND` / `PROJECT_INVALID` | 目录或 `project.vr.json` 不在、schema 不合法 | 先 `vidroom_project action=inspect` 看缺什么 |
| `PROJECT_HASH_MISMATCH` / `PLAN_HASH_MISMATCH` | 工程或计划在算完以后变了 | 重新 `vidroom_plan` 再 render |
| `PATCH_REJECTED` | 改了白名单外的字段 | 只动文案/提示词/种子/选定/样式这类创作字段 |
| `BUDGET_EXCEEDED` | 变体数/新请求数/磁盘/时长超预算 | 调小批量,或在工程 `budget` 里显式放宽 |
| `ALIGNMENT_REQUIRED` | 词锚对应的词被删、音轨或裁切换过 | 重新 `vidroom_align_words`,不要复用旧窗口 |
| `MEDIA_TOOL_MISSING` | 本机没有 ffmpeg/ffprobe | 装上再跑,插件不会自己下载 |
| `UNSUPPORTED_PARAMS` | 帧数/尺寸不符合 H3 网格 | 帧数按 17k+5、边长按 32 的倍数 |
| `CANDIDATE_UNAVAILABLE` | 选定/引用的候选不存在或 status 不是 available | 先出候选或换一条 |
| `LOCAL_ONLY` | 地址不是回环 | 本插件只连本机 ComfyUI |
| `RENDER_FAILED` | 准入没过、ComfyUI 报错、ffmpeg 失败 | 照回执里的原文报错说,别猜 |
| `ALREADY_RUNNING` / `RUN_NOT_FOUND` | 同一工程已有在跑的 run / runId 不存在 | 先 `vidroom_job` 查现状 |

## 回执里该核什么

`vidroom_job { runId }` 给的 `receipt`:状态(`queued/running/succeeded/failed/cancelled`,
工程 run 另有 `awaiting-selection` / `awaiting-alignment`)、逐镜头 `{shotId, candidateId, assetId, actualFrames}`、
产物 `{path, sha256, probe}`、`checks`(工程哈希/计划哈希对得上吗、这次真投了几条 ComfyUI 请求、复用了几条候选、
ffmpeg 版本),以及日志。失败也把已经生成的候选留在工程里,下一次 run 显式复用,不盲重投。

## 不做的

不做自动抓平台参考片;不做任何内容外发/上传/分享/发布;不用云端模型理解参考内容;
不引入 ASR/OCR/VLM/TTS 模型(转写、分词、词时序首版都是人工录入/校订);
不承诺 H3 准确念稿或复刻音色;不实现 Hypit 的 SVML 兼容层;不做独立壳、多租户与收费。
