// 模拟 Host:起一个(假)ComfyUI 然后一直挂着;测试把这个进程强杀,看 ComfyUI 会不会成孤儿
import { ComfyProcess } from '../../src/comfyui/process.js';

const [comfyDir, python, ...extraArgs] = process.argv.slice(2);
const proc = await ComfyProcess.start({ install: { comfyDir, python, source: 'local' }, extraArgs });
console.log(`COMFY_PID=${proc.pid}`);
setInterval(() => {}, 60_000);
