# 工作流库

VidRoom 工作流是一份 `SKILL.md`:给人看的是 Markdown,给 Host 跑的是同文件里的窄 `workflow` steps。

## 存放位置

每个工作流一个目录:

```text
<VIDROOM_DATA_DIR>/workflows/<slug>/SKILL.md
```

`slug` 必须是小写 ascii 短横线格式,并且等于 frontmatter 里的 `name`。

## SKILL.md 格式

````markdown
---
name: topic-to-video
title: 默认工作流
description: 一句主题 → 文案和 3 个分镜 → 3 段出片 → 拼接 → 烧字幕
builtin: true
---
# 默认工作流

给人看的说明。

```workflow
steps:
  - id: script
    tool: write_script
    args: { shots: 3 }
  - id: shots
    tool: generate_video
    each: "{{script.shots}}"
    args: { prompt: "{{item.prompt}}", seconds: 3 }
  - id: joined
    tool: concat_videos
    args: { video_ids: "{{shots.ids}}" }
  - id: final
    tool: add_subtitle
    args: { video_id: "{{joined.id}}", text: "{{script.caption}}" }
```
````

Frontmatter 字段:

- `name`:必填,ascii slug,等于目录名。
- `title`:必填,页面显示名。
- `description`:必填,一句话说明。
- `builtin`:可选,`true` 表示内置工作流。

## steps DSL

这是窄 DSL,只支持 VidRoom 已有工具,不是通用编排器。

可用工具:

- `write_script`:runner 内部步骤,把运行主题交给当前 LLM,要求返回 `{ caption, shots }` JSON。`caption` 最多 200 字;`shots` 数量默认 3,每项有英文 `prompt`。
- `generate_video`:复用聊天 agent 的 MiniMax H3 工具定义。
- `trim_video`:复用剪切工具定义。
- `concat_videos`:复用拼接工具定义。
- `add_subtitle`:复用字幕工具定义。
- `render_motion`:复用代码渲染工具定义。
- `list_videos`:复用作品库查询工具定义。

取值只支持三种:

- `{{topic}}`:运行时填的一句主题。
- `{{<步骤id>.<字段>}}`:引用前面步骤输出。
- `{{item.<字段>}}`:只在 `each` 展开时可用。

`each` 必须解析成数组。每次执行的输出会按顺序聚成 `{ outputs, ids }`;后续步骤可用 `{{shots.ids}}` 传给 `concat_videos`。

## 默认工作流

内置默认工作流由源码里的字符串常量物化到数据目录,避免桌面版 esbuild 单文件打包后找不到仓内 `.md` 文件。Host 首次启动时如果没有 `<数据目录>/workflows/topic-to-video/SKILL.md` 才写入;用户改过后不会覆盖。

默认工作流步骤:

1. `write_script`:一句主题 → 一行字幕文案 + 3 个英文分镜提示词。
2. `generate_video ×3`:每段 `seconds: 3`;MiniMax H3 会按 `framesForSeconds(3)` 吸附到 73 帧。
3. `concat_videos`:按顺序拼接 3 段。
4. `add_subtitle`:把文案烧成字幕。

## 从聊天保存

用户在聊天里表达“以后都这么做 / 保存这个流程”这类意图时,由 LLM 决定是否调用 `save_workflow`。代码里不做关键词表或正则猜意图。

`save_workflow` 入参:

```json
{
  "name": "custom-topic-video",
  "title": "自定义主题成片",
  "description": "测试保存的主题成片流程",
  "steps": []
}
```

保存后会写入 `<数据目录>/workflows/<name>/SKILL.md`,重启 Host 后仍能在工作流库看到并运行。

## 编辑与运行

页面的“工作流库”里每条工作流都能:

- 填一句主题并运行。
- 查看 `SKILL.md` 原文。
- 修改原文并保存;坏 frontmatter 或坏 steps 会被拒绝,不会落盘。

没有配置 API key 时,包含 `write_script` 的工作流会失败并提示“没有配置 API key,请去设置。”本批 e2e 用假 LLM + 假 ComfyUI 回放验证流程,真 MiniMax H3 出片留给第 7 批。
