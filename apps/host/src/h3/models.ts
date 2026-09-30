import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { downloadVerified, sha256File } from '../comfyui/download.js';
import { dataDir } from '../comfyui/install.js';

/**
 * MiniMax H3 文生视频要的四个权重文件(官方模板 video_minimax_h3_t2v 的默认组合,见 workflows/README.md)。
 *
 * 数值取自 Hugging Face API(2026-10-01 查):
 *   https://huggingface.co/api/models/Comfy-Org/MiniMax-H3/tree/main?recursive=1
 * 每个文件的 `lfs.size` 与 `lfs.oid`(即文件的 sha256)。下载地址钉在同一时刻仓库的 commit(HF_REVISION)上,
 * 不跟 main 走。原始响应存在 test/fixtures/hf-comfy-org-minimax-h3-tree.json,单测逐项核对。
 */

export const HF_REPO = 'Comfy-Org/MiniMax-H3';
export const HF_REVISION = 'e5eb578a89295337b8ff433a035929ce0279e0b6';

export interface ModelFile {
  /** ComfyUI 的模型目录名(models/ 下的子目录,也是 /models/{folder} 接口的 folder) */
  folder: 'diffusion_models' | 'text_encoders' | 'vae';
  fileName: string;
  size: number;
  sha256: string;
  role: string;
}

export const H3_MODEL_FILES: readonly ModelFile[] = [
  {
    folder: 'diffusion_models',
    fileName: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
    size: 20_970_379_616,
    sha256: 'e889202c41dafb67b10d67b97f0d8541508036a6090af23425a5c2615d03c47a',
    role: '扩散主干',
  },
  {
    folder: 'text_encoders',
    fileName: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    size: 15_687_142_551,
    sha256: '35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6',
    role: '文本编码器',
  },
  {
    folder: 'vae',
    fileName: 'minimax_h3_video_vae_int8_convrot.safetensors',
    size: 2_811_065_184,
    sha256: '52a2c8c73583c86e4f41cdcce3a6ad0ea562987bc0bf3d60a0cef5f5c8e60c0e',
    role: '视频 VAE',
  },
  {
    folder: 'vae',
    fileName: 'minimax_h3_audio_vae_fp32.safetensors',
    size: 605_254_808,
    sha256: '8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48',
    role: '音频 VAE',
  },
];

export const MODELS_DIR_ENV = 'VIDROOM_MODELS_DIR';
/** 换镜像:给一个前缀,文件地址是 `<前缀>/<folder>/<fileName>`。下完照样按清单 sha256 校验。 */
export const H3_DOWNLOAD_BASE_ENV = 'VIDROOM_H3_DOWNLOAD_BASE';

/** 模型目录与 ComfyUI 本体分开放(换 ComfyUI 版本、重装便携包都不用重下几十 GB) */
export function modelsDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return env[MODELS_DIR_ENV] || join(dataDir(env, platform), 'models');
}

export function modelUrl(file: ModelFile, env: NodeJS.ProcessEnv = process.env): string {
  const base = env[H3_DOWNLOAD_BASE_ENV]?.trim().replace(/\/+$/, '');
  if (base) return `${base}/${file.folder}/${file.fileName}`;
  return `https://huggingface.co/${HF_REPO}/resolve/${HF_REVISION}/${file.folder}/${file.fileName}`;
}

export const modelPath = (dir: string, file: ModelFile) => join(dir, file.folder, file.fileName);

/**
 * ComfyUI 的 --extra-model-paths-config:让 ComfyUI 到我们的模型目录找权重。
 * YAML 用单引号标量(反斜杠原样,单引号写两个),Windows 路径不用转义。
 */
export async function writeExtraModelPaths(configPath: string, dir: string): Promise<void> {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const folders = [...new Set(H3_MODEL_FILES.map((f) => f.folder))];
  const yaml = ['vidroom:', `  base_path: ${q(dir)}`, ...folders.map((f) => `  ${f}: ${q(f)}`), ''].join('\n');
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, yaml);
}

export type FileState = 'ok' | 'missing' | 'mismatch';

export interface FileStatus {
  folder: string;
  fileName: string;
  role: string;
  size: number;
  state: FileState;
}

/**
 * 哪些文件本地已有且 sha256 对得上。几十 GB 每次都算 sha256 太慢:算过一次就把
 * (路径、大小、修改时间、sha256)记进缓存文件,大小和修改时间都没变就信缓存。
 */
export class ModelStore {
  constructor(
    readonly dir: string,
    private readonly cacheFile: string,
    private readonly files: readonly ModelFile[] = H3_MODEL_FILES,
  ) {}

  async inspect(): Promise<FileStatus[]> {
    const cache = await this.readCache();
    const out: FileStatus[] = [];
    let dirty = false;
    for (const f of this.files) {
      const path = modelPath(this.dir, f);
      let state: FileState;
      const st = await stat(path).catch(() => null);
      if (!st) state = 'missing';
      else if (st.size !== f.size) state = 'mismatch';
      else {
        const hit = cache[path];
        let sha = hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs ? hit.sha256 : null;
        if (sha === null) {
          sha = await sha256File(path);
          cache[path] = { size: st.size, mtimeMs: st.mtimeMs, sha256: sha };
          dirty = true;
        }
        state = sha === f.sha256 ? 'ok' : 'mismatch';
      }
      out.push({ folder: f.folder, fileName: f.fileName, role: f.role, size: f.size, state });
    }
    if (dirty) await this.writeCache(cache);
    return out;
  }

  /** 下载所有不是 ok 的文件(sha256 对不上的删掉重下,见 downloadVerified)。已有且对得上的一律跳过。 */
  async downloadMissing(opts: {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    log?: (msg: string) => void;
    onFile?: (file: ModelFile) => void;
    onProgress?: (received: number, total: number) => void;
  } = {}): Promise<ModelFile[]> {
    const status = await this.inspect();
    const todo = this.files.filter((_, i) => status[i].state !== 'ok');
    for (const f of todo) {
      opts.onFile?.(f);
      const dest = modelPath(this.dir, f);
      await mkdir(dirname(dest), { recursive: true });
      await downloadVerified({
        url: modelUrl(f, opts.env),
        dest,
        size: f.size,
        sha256: f.sha256,
        signal: opts.signal,
        log: opts.log,
        onProgress: opts.onProgress,
      });
      const st = await stat(dest);
      const cache = await this.readCache();
      cache[dest] = { size: st.size, mtimeMs: st.mtimeMs, sha256: f.sha256 };
      await this.writeCache(cache);
    }
    return todo;
  }

  private async readCache(): Promise<Record<string, { size: number; mtimeMs: number; sha256: string }>> {
    try {
      return JSON.parse(await readFile(this.cacheFile, 'utf8'));
    } catch {
      return {};
    }
  }

  private async writeCache(cache: object): Promise<void> {
    await mkdir(dirname(this.cacheFile), { recursive: true });
    await writeFile(this.cacheFile, JSON.stringify(cache, null, 2));
  }
}
