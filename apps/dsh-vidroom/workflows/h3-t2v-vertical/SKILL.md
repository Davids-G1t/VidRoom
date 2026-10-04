---
name: h3-t2v-vertical
title: 主题直出(竖屏 9:16)
description: 一句主题 → 一段 5 秒竖屏的 MiniMax H3 本地视频
builtin: true
---
# 主题直出(竖屏 9:16)

和「主题直出(横屏 16:9)」同一条流程,只把画面换成竖屏 —— 手机上看的那一档。

- 尺寸:9:16、0.4 MP → 480x864
- 时长:5 秒 → 124 帧(24 fps)

```workflow
steps:
  - id: video
    tool: generate_video
    args: { prompt: "{{topic}}", seconds: 5, megapixels: 0.4, aspect: "9:16" }
```

竖屏片在同一档显存下比横屏慢一点(边长更小但帧数一样),耗时可接受。
