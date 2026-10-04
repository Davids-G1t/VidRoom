/**
 * 「一个进程拿着锁在写、另一个进程同时来写」那条用例的第二、第三个进程 —— 不是给 `pnpm test`
 * 单独跑的一条用例:`VR_LOCK_CHILD_MODE` 没点着的时候整份跳过(`batch2.test.ts` 会点着它起两个)。
 *
 * 两个模式:
 * - `hold`:用真的 `withProjectLock` 拿住工程写锁,拿住之后**在临界区里**写下 `.held` 信号,
 *   然后等对方那次尝试落地(`VR_LOCK_CHILD_WAIT_OUT` 出现)才办自己的事(锁内 +1)并放锁。
 * - `contend`:等 `.held` 出现(此刻对方确实在临界区里),立刻试一次 `updateProject`,
 *   把结果(`PROJECT_BUSY` / `wrote`)写给父进程。
 *
 * 为什么这么写:不让「谁先谁后」交给调度运气。拿锁那个进程在锁里等对方的尝试结果,
 * 所以对方被挡下那一下**一定**发生在自己放锁之前 —— 没有锁的实现里对方会写成功,这条就红;
 * 有锁的实现里对方必然被挡下,这条不会随机绿也不会随机红。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { readProject, updateProject, withProjectLock, writeProject } from '../src/project-io.js';
import { projectHash } from '../src/project.js';

const mode = process.env.VR_LOCK_CHILD_MODE;
const dir = process.env.VR_LOCK_CHILD_DIR;
const out = process.env.VR_LOCK_CHILD_OUT;
const held = process.env.VR_LOCK_CHILD_HELD;
const waitOut = process.env.VR_LOCK_CHILD_WAIT_OUT;

/** 忙等一小会儿(同步,不引依赖):这些子进程里要的是「马上再试一次」,不是真睡。 */
function pause(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
}

/** 等一个文件出现(同步忙等):等的是对方在临界区里亲手写下的证据,不是猜出来的毫秒数。 */
function waitFor(file: string, message: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(message);
    pause();
  }
}

describe.skipIf(mode === undefined || dir === undefined || out === undefined || held === undefined)(
  '跨进程写锁(子进程)',
  () => {
    it('按模式拿住锁 / 试一次写,把结果写给父进程', () => {
      if (mode === undefined || dir === undefined || out === undefined || held === undefined) {
        throw new Error('缺 VR_LOCK_CHILD_MODE / VR_LOCK_CHILD_DIR / VR_LOCK_CHILD_OUT / VR_LOCK_CHILD_HELD');
      }

      if (mode === 'hold') {
        withProjectLock(dir, (assertOwned) => {
          // 在临界区里留个记号:对方就是等它才动手的。
          writeFileSync(held, `${process.pid}\n`);
          if (waitOut !== undefined) {
            waitFor(waitOut, '对方那次尝试一直没落地(锁拿住了,但没人来抢?)', 60_000);
          }
          assertOwned();
          const current = readProject(dir);
          writeProject(dir, { ...current, revision: current.revision + 1, parentHash: projectHash(current) });
        });
        writeFileSync(out, 'wrote\n', 'utf8');
        return;
      }

      if (mode === 'contend') {
        waitFor(held, '对方没在临界区里就位', 60_000);
        const result = ((): string => {
          try {
            updateProject(dir, (current) => ({
              ...current,
              revision: current.revision + 1,
              parentHash: projectHash(current),
            }));
            return 'wrote';
          } catch (error) {
            return (error as { code?: string }).code ?? `error:${(error as Error).message}`;
          }
        })();
        // 写文件而不是打 stdout:子进程是另一个 vitest,自己的输出会被它自己的报告吃掉。
        writeFileSync(out, `${result}\n`, 'utf8');
        return;
      }

      throw new Error(`VR_LOCK_CHILD_MODE 只认 hold / contend,收到 ${mode}`);
    }, 120_000);
  },
);
