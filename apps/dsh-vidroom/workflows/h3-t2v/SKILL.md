---
name: h3-t2v
title: 主题直出(横屏 16:9)
description: 一句主题 → 一段 5 秒 16:9 的 MiniMax H3 本地视频
builtin: true
---
# 主题直出(横屏 16:9)

最简单的一条:把一句主题交给本机 ComfyUI 上的 MiniMax H3,出一段 5 秒横屏短片(带声音)。
产物落在 ComfyUI 的 output 目录,面板里可以直接播。

- 尺寸:16:9、0.4 MP → 864x480(H3 模板默认,老 VidRoom 用的同一档)
- 时长:5 秒 → 124 帧(24 fps)
- 每一步的耗时:5080 上约几分钟,显存峰值十几个 GiB

```workflow
steps:
  - id: video
    tool: generate_video
    args: { prompt: "{{topic}}", seconds: 5, megapixels: 0.4, aspect: "16:9" }
```

想改尺寸或时长,直接在面板的运行框里给覆盖值(seconds / megapixels / aspect),
不用改这份文件。
