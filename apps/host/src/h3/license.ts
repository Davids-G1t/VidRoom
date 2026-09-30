import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * MiniMax H3 社区许可(MiniMax H3 Community License Agreement)。
 * 原文随聊天页分发:apps/web/public/licenses/MiniMax-H3-LICENSE.txt(页面地址 /licenses/MiniMax-H3-LICENSE.txt),
 * 取自 https://huggingface.co/MiniMaxAI/MiniMax-H3 的 LICENSE,钉在下面的 commit。单测核对文件 sha256 与这里一致。
 */
export const H3_LICENSE = {
  name: 'MiniMax H3 Community License Agreement',
  source: 'https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/LICENSE',
  sha256: '59b99642b95ea21630e311198ddbfffbfe05aadba0c2f5d884cbdf4efcc90f44',
  path: '/licenses/MiniMax-H3-LICENSE.txt',
} as const;

/** 许可第 III.4 条要求的 NOTICE 原文(「关于」页照录) */
export const H3_NOTICE =
  'MiniMax H3 is licensed under the MiniMax H3 Community License Agreement, Copyright © 2026 MiniMax. All Rights Reserved.';

export interface ConsentRecord {
  licenseSha256: string;
  /** ISO 8601 */
  acceptedAt: string;
}

/**
 * 下载 H3 权重前的同意记录,存在本地一个 JSON 文件里。
 * 只认「同意的是当前这份许可」的记录:许可换版(sha256 变了)就当没同意过,要重新勾选。
 */
export class ConsentStore {
  constructor(private readonly file: string) {}

  async get(): Promise<ConsentRecord | null> {
    try {
      const r = JSON.parse(await readFile(this.file, 'utf8')) as ConsentRecord;
      return r.licenseSha256 === H3_LICENSE.sha256 && typeof r.acceptedAt === 'string' ? r : null;
    } catch {
      return null;
    }
  }

  /** 页面提交的 sha256 必须是当前许可的,防止旧页面拿旧版本许可来点同意 */
  async accept(licenseSha256: string, now = new Date()): Promise<ConsentRecord> {
    if (licenseSha256 !== H3_LICENSE.sha256) throw new Error('同意的许可版本和当前的不一致,请刷新页面重新阅读');
    const record: ConsentRecord = { licenseSha256, acceptedAt: now.toISOString() };
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(record, null, 2));
    return record;
  }
}
