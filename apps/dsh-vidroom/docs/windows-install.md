# 在这台 Windows 机器上装 VidRoom(给本机 AI agent 的任务书)

你在一台 Windows 机器上,任务是**把 VidRoom 这条链路装通**:装完以后,用户在一个叫 dsh 的应用里说一句话,就能用**这台机器的显卡**生成一小段视频。

请按顺序做,**每步做完先自检再往下**;某步失败先自己排查一轮,仍不通就把原始报错留下、跳过它继续做后面的,最后一起报告。

> 下面命令里出现的 `D:` 只是举例 —— **换成这台机器上剩余空间最大的那个盘**(全文同理)。

---

## 0. 边界(先看,别越界)

- 只装本任务书列的东西,**不动这台机器的其他配置**(不改系统设置、不装无关软件、不动别人的目录)。
- 下载和安装都放**剩余空间最大的那个盘**(优先 D:),不要塞 C: 盘。**总共要 60GB 以上空闲**。
- 全程**不访问云端 AI 服务、不上传任何文件**;只用本机显卡。
- 这是**个人自用**安装:不要把生成的视频发到任何平台。
- 装的东西:*dsh 桌面端 / ComfyUI / 四个模型文件 / ffmpeg / VidRoom 插件*。除此之外**不要**顺手装别的。

---

## 1. 先探测,把结果贴出来(这一步先做)

```powershell
nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv
Get-ComputerInfo | Select-Object OsName,OsVersion,CsTotalPhysicalMemory
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,@{n='FreeGB';e={[math]::Round($_.FreeSpace/1GB,1)}}
foreach ($c in 'dsh','node','pnpm','git','ffmpeg','7z') {
  $p = (Get-Command $c -ErrorAction SilentlyContinue).Source
  if (-not $p) { $p = '没有' }
  "{0,-8} {1}" -f $c, $p
}
```

**判断标准**:显卡要能看到(NVIDIA,显存 20GB 以上)、有盘剩 ≥60GB、驱动正常。
如果 `nvidia-smi` 没有输出 → 先停下报告,别继续。

---

## 2. 装 dsh 桌面端(宿主)

```powershell
curl.exe -L -o "$env:TEMP\dsh-setup.exe" https://download.deepseek.com/dsh-desk/bin/win-x64/dsh-latest-win-x64.exe
& "$env:TEMP\dsh-setup.exe"
```

装完:打开 dsh → 菜单里找 **「Manage dsh command…」** 点一下(把 `dsh` 命令注册进 PATH)→ **新开一个 PowerShell** → `dsh --version` 要有输出。

> 它自带 Node 运行时,**不需要**你另装 Node。

---

## 3. 装 ComfyUI(官方 Windows 便携包)

```powershell
# v0.38.0(2026-09-29),1,994,326,521 字节
curl.exe -L -o "D:\comfy.7z" https://github.com/Comfy-Org/ComfyUI/releases/download/v0.38.0/ComfyUI_windows_portable_nvidia.7z
Get-FileHash "D:\comfy.7z" -Algorithm SHA256   # 必须是 8f137eac345707fd7e42bcf8e29377415243011ca15522a86aed6c77331fbd56
```

- 用 7-Zip(没有就 `winget install -e --id 7zip.7zip`)把它解压到 `D:\`。
- ⚠️ **压缩包解开后的顶层目录叫 `ComfyUI_windows_portable`**(真正的东西在它里面)。**把这层改名成 `ComfyUI`**,最终必须是这个结构:

  ```
  D:\ComfyUI\run_nvidia_gpu.bat
  D:\ComfyUI\ComfyUI\models\
  D:\ComfyUI\python_embeded\
  ```

  少了改名这一步,后面第 4、7 步全都会落在错的目录上 —— 这一步别省。
- 双击 `D:\ComfyUI\run_nvidia_gpu.bat` 起服务,等它加载完。
- **自检**:浏览器打开 `http://127.0.0.1:8188` 能看到界面 → 就是成了。看住了以后让它**一直开着**。
- 这一版**自带 Python 3.13 + PyTorch CUDA 13.0**,不要再升级或替换 torch。
- ⚠️ 不要下 `_nvidia_cu126.7z` 那个包(那是给老驱动/老显卡的)。

---

## 4. 下四个模型文件(共 40.1GB)

放进 ComfyUI 的模型目录(**目录名必须一模一样**):

| 放到 | 文件名 | 字节数 | sha256 |
| --- | --- | --- | --- |
| `D:\ComfyUI\ComfyUI\models\diffusion_models\` | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | 20970379616 | e889202c41dafb67b10d67b97f0d8541508036a6090af23425a5c2615d03c47a |
| `D:\ComfyUI\ComfyUI\models\text_encoders\` | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | 15687142551 | 35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6 |
| `D:\ComfyUI\ComfyUI\models\vae\` | `minimax_h3_video_vae_int8_convrot.safetensors` | 2811065184 | 52a2c8c73583c86e4f41cdcce3a6ad0ea562987bc0bf3d60a0cef5f5c8e60c0e |
| `D:\ComfyUI\ComfyUI\models\vae\` | `minimax_h3_audio_vae_fp32.safetensors` | 605254808 | 8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48 |

- 下载地址(HF 仓 `Comfy-Org/MiniMax-H3`;两条是同名文件的两种源,ModelScope 那条国内通常更快,但**没有实测过全量下载**,下不动就换回 HF):

  ```
  https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/<相对路径>
  https://modelscope.cn/models/Comfy-Org/minimax-H3/resolve/master/<相对路径>

  例:https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors
  ```

- 20GB 那个大文件建议用支持断点续传的方式下(curl 加 `-C -` 可续传),下完**逐个核对字节数与 sha256**。
- **如果这台机器上已经有同名文件**:先核对字节数,一致就跳过,**不要重下**。
- **自检**:四个文件都在、字节数与 sha256 都对、ComfyUI 界面里模型列表能看到它们。

> 许可提示(MiniMax H3 是社区许可模型):适用地区**不含**欧盟、英国、韩国、美国;附件 A 有 20 条禁用用途;不许拿生成的视频去训练别的模型。本仓 `docs/USE-POLICY.md` 是转给用户的完整条款。这次是个人自用安装:**不要把生成的视频发到公开平台**。

---

## 5. 装 ffmpeg(合成与探测要用,缺了插件会直接报错)

```powershell
# 与仓内选型一致的那一版(LGPL 构建,版本与哈希都锁死),67,201,333 字节
curl.exe -L -o "D:\ff.zip" https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n9.0.1-11-ge47273f4d9-win64-lgpl-shared-9.0.zip
Get-FileHash "D:\ff.zip" -Algorithm SHA256   # 必须是 83a824f0729a69d143c9865125bb86988a11dd388325f0033711045522068aa0
```

解压到 `D:\ffmpeg`(里面是 `bin\ffmpeg.exe` 与 `bin\ffprobe.exe`)。

图省事也可以 `winget install -e --id Gyan.FFmpeg` —— 那是 GPL 构建、版本不钉,自用无所谓,只是不如上面那版可核对。

**自检**:`D:\ffmpeg\bin\ffmpeg.exe -version` 与 `...\ffprobe.exe -version` 都有输出。
没加进 PATH 没关系,把这两个完整路径记下来(第 7 步要填进配置)。

---

## 6. 装 VidRoom 插件

VidRoom 的源码在公开仓 `Davids-G1t/VidRoom` 里,插件在 `apps/dsh-vidroom`。它需要先构建一次。

```powershell
winget install -e --id OpenJS.NodeJS.LTS      # 装完新开一个 PowerShell
curl.exe -L -o "$env:TEMP\vr.zip" https://codeload.github.com/Davids-G1t/VidRoom/zip/refs/heads/main
Expand-Archive "$env:TEMP\vr.zip" -DestinationPath D:\vidroom-src -Force
cd D:\vidroom-src\VidRoom-main
corepack pnpm install
corepack pnpm --filter dsh-vidroom pack        # 在当前目录产出 dsh-vidroom-0.1.0.tgz
dsh plugin --profile desktop add (Resolve-Path .\dsh-vidroom-0.1.0.tgz)
```

装完**重启 dsh**。
**自检**:侧栏出现 **VidRoom** 面板入口;聊天里 agent 多出 `vidroom_generate` 等工具。

> 手上已经有别人打好的 `dsh-vidroom-0.1.0.tgz` 时,这一整段可以跳过,直接
> `dsh plugin --profile desktop add <tgz 的完整路径>`(那份 158KB 的包里已经带好构建产物,不需要再装 Node)。
> 如果 `corepack pnpm install` 报错,先 `corepack enable` 再试。

---

## 7. 接线(最容易漏的一步,不做的话工作流会报「模型找不到」)

插件**不看** ComfyUI 的模型目录,它只认自己配置里的 `modelsRoot`。**两处必须指向同一堆文件**。

找到 dsh 的配置文件(桌面端数据目录在 `%USERPROFILE%\.dsh` 下,具体文件按 dsh 的界面/文档确认),加上这一段:

```yaml
vidroom:
  baseUrl: http://127.0.0.1:8188
  modelsRoot: D:\ComfyUI\ComfyUI\models
  # 如果 ffmpeg 没进 PATH,再加这两行:
  # ffmpegPath: D:\ffmpeg\bin\ffmpeg.exe
  # ffprobePath: D:\ffmpeg\bin\ffprobe.exe
```

改完**重启 dsh**,面板里应显示连上了 `127.0.0.1:8188`、且本机就绪。

> 两个坑:① `baseUrl` **只接受本机回环地址**,填局域网 IP 会被拒;② 显存 ≥24GB 默认放行,20–24GB 属于要显式开 `allowExperimental` 的实验档。

---

## 8. 验收(做完这几条才算装通)

1. `dsh --version` 有输出;
2. `http://127.0.0.1:8188` 能打开,ComfyUI 能看到那四个模型;
3. VidRoom 面板能打开、显示连上了 ComfyUI;
4. 用面板里的内置工作流 `h3-t2v` 跑**最短的一档**(5 秒 / 0.4MP),等到 mp4 出现在作品库里能播放。

第 4 条**第一次跑很可能要排障**(显存、路径、驱动),排不动就把报错和日志留下来报告,不要反复重试烧时间。

---

## 9. 报告格式(做完把这一段发回来)

```
【VidRoom 装机报告】
机器:  显卡型号 / 显存 / 内存 / 系统版本
第 1 步 探测:     (贴结果)
第 2 步 dsh:      成功/失败 + 版本号
第 3 步 ComfyUI:  成功/失败 + 路径 + 版本 + sha256 是否一致
第 4 步 模型:     4 个文件是否都在 + 字节数与 sha256 核对结果
第 5 步 ffmpeg:   成功/失败 + 路径
第 6 步 插件:     成功/失败 + 面板是否出现
第 7 步 接线:     modelsRoot 填的什么 + 面板是否显示就绪
第 8 步 出片:     成功/失败 + 若成功给成片文件路径与耗时;若失败贴最后 30 行报错
没做成的事:       逐条写清卡在哪、原始报错
```

**不要**省略失败项。装不上就照实写,比自己猜一个「应该可以了」有用得多。
