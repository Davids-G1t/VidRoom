/**
 * 第 2 批的机器可判错误码。工具与路由都靠 `code` 说话 —— 面板和模型看这一行就知道
 * 该去找什么,不用从中文句子里猜(旧仓的 `ok=false/reason` 口径继续沿用)。
 */

/** 设计页里点名要的错误码,别改字面量。 */
export type VidroomErrorCode =
  | 'REFERENCE_LOCAL_REQUIRED'
  | 'ALIGNMENT_REQUIRED'
  | 'PROJECT_INVALID'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_HASH_MISMATCH'
  | 'PLAN_HASH_MISMATCH'
  | 'WORKFLOW_MISMATCH'
  /** 盘上权重与工程 `locks.models` 记的对不上(换了权重就是换了环境,结果不可比)。 */
  | 'MODEL_MISMATCH'
  | 'PATCH_REJECTED'
  | 'BUDGET_EXCEEDED'
  | 'LOCAL_ONLY'
  | 'MEDIA_TOOL_MISSING'
  | 'CANDIDATE_UNAVAILABLE'
  | 'UNSUPPORTED_PARAMS'
  | 'RENDER_FAILED'
  | 'IO_ERROR'
  | 'RUN_NOT_FOUND'
  | 'ALREADY_RUNNING';

export class VidroomError extends Error {
  constructor(
    readonly code: VidroomErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VidroomError';
  }
}

/** 把任意抛出来的东西读成 `{code, message}`(路由与回执共用)。 */
export function errorFacts(error: unknown): { code: string; message: string } {
  if (error instanceof VidroomError) return { code: error.code, message: error.message };
  return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };
}
