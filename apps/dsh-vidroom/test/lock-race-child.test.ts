/**
 * 「两个进程同时改同一条工程」那条用例的第二、第三个进程 —— 不是给 `pnpm test` 单独跑的一条用例:
 * `VR_LOCK_RACE_DIR` / `VR_LOCK_RACE_OUT` 没点着的时候整份跳过(`batch2.test.ts` 会点着它起两个)。
 *
 * 干的事和真写者一样:反复「锁内读-改-写」,每次成功把 revision 加一。父进程拿两个进程各自
 * 报上的成功次数与工程最终 revision 对账 —— 只要有两次写并了(两个写者同时读、同时写),
 * 后写的那份就把先写的整份盖掉,账立刻对不上。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { updateProject } from '../src/project-io.js';
import { projectHash } from '../src/project.js';

const raceDir = process.env.VR_LOCK_RACE_DIR;
const raceOut = process.env.VR_LOCK_RACE_OUT;
const rounds = Number.parseInt(process.env.VR_LOCK_RACE_ROUNDS ?? '0', 10);

/** 忙等一小会儿(同步,不引依赖):让两个进程的读-改-写更容易真撞上。 */
function pause(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
}

/** 等一个文件出现(同步忙等)。 */
function waitFor(file: string, message: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(message);
    pause();
  }
}

describe.skipIf(raceDir === undefined || raceOut === undefined)('同时改同一条工程(子进程)', () => {
  it('反复锁内读-改-写,把成功次数写给父进程', () => {
    if (raceDir === undefined || raceOut === undefined) {
      throw new Error('缺 VR_LOCK_RACE_DIR / VR_LOCK_RACE_OUT');
    }
    // 起跑线:先告诉父进程「我到了」,等两个进程都到了再一起开跑 —— 不然两边一先一后跑完,
    // 就算锁是坏的,两边也都写满了,父进程看不出差别。
    writeFileSync(`${raceOut}.ready`, '');
    waitFor(`${raceOut}.go`, '没等到起跑信号', 30_000);

    const deadline = Date.now() + 60_000;
    let written = 0;
    while (written < rounds) {
      try {
        updateProject(raceDir, (current) => ({
          ...current,
          revision: current.revision + 1,
          parentHash: projectHash(current),
        }));
        written += 1;
      } catch (error) {
        // 锁在别人手里的那一小会儿:重试,不算失败(真出错就抛出去,让父进程看见)。
        if ((error as { code?: string }).code !== 'PROJECT_BUSY') throw error;
        // 一直拿不到锁时,把「写进了多少次」写进报错:不然父进程只看到子进程退出码 1,
        // 分不出「卡在拿锁」还是「别的真的挂了」。
        if (Date.now() > deadline) {
          throw new Error(
            `等了 60 秒还是没拿到锁(只写进 ${written}/${rounds} 次):${raceDir} 旁边那把锁可能是别人留下的`,
          );
        }
      }
      pause();
    }
    // 写文件而不是打 stdout:子进程是另一个 vitest,自己的输出会被它自己的报告吃掉。
    writeFileSync(raceOut, `${written}\n`, 'utf8');
  }, 120_000);
});
