"""假 ComfyUI(只用 Python 标准库 + 外部 ffmpeg),给单测和 e2e 用:不需要 PyTorch、不需要显卡,不加载任何模型。

- /system_stats、首页:起停测试用。
- 「假回放」出片:模拟 ComfyUI 的出片 API ——
  POST /prompt 收工作流(校验是 H3 文生视频模板的形状、帧数在 17k+5 网格上,不对就像真 ComfyUI 一样回 400)→
  /ws?clientId= 上推 execution_start / executing / progress(20 步)/ executed / execution_success →
  用 ffmpeg 的 testsrc 滤镜生成一段**占位** MP4(不是模型输出),元数据照真 SaveVideo 的做法写 extra_pnginfo 的每个键 →
  GET /history/<id> 查结果,GET /view 取文件;POST /interrupt 打断。
  /system_stats 里的显存/内存数字是编的,并带 vidroom_fake_replay: true,Host 据此把指标标成「模拟值」。

环境变量:
  FAKE_COMFY_IGNORE_STOP=1   忽略 Ctrl+C,测「不肯退就强杀」
  FAKE_COMFY_REQUEST_LOG=<路径>  每个 POST /prompt 的请求体追加一行 JSON(测试核对「/prompt 有没有被调用、发了什么」)
  FAKE_COMFY_STEP_MS=<毫秒>  每一步采样的假耗时,默认 150
  FAKE_COMFY_FFMPEG=<路径>   ffmpeg 可执行文件,默认 PATH 上的 ffmpeg
  FAKE_COMFY_EAT_MEMORY_MB=<n>  起来 2 秒后开始每 100 毫秒多占 n MiB 内存、永不释放(测 Windows 作业对象内存上限)
"""
import argparse
import base64
import hashlib
import json
import os
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

parser = argparse.ArgumentParser()
parser.add_argument('--listen', default='127.0.0.1')
parser.add_argument('--port', type=int, default=8188)
parser.add_argument('--output-directory', default=None)
args, _ = parser.parse_known_args()

OUTPUT_DIR = args.output_directory or tempfile.mkdtemp(prefix='fake-comfy-out-')
STEPS = 20
STEP_S = int(os.environ.get('FAKE_COMFY_STEP_MS', '150')) / 1000
GIB = 1024 ** 3

lock = threading.Lock()
sockets = {}          # clientId -> socket
history = {}          # prompt_id -> history entry
busy = {'on': False}  # 正在「出片」时报更高的显存/内存占用
interrupted = threading.Event()
counter = {'n': 0}

REQUIRED = {
    'UNETLoader', 'CLIPLoader', 'VAELoader', 'MiniMaxH3ImageToVideo', 'BasicGuider', 'KSamplerSelect',
    'BasicScheduler', 'RandomNoise', 'SamplerCustomAdvanced', 'VAEDecode', 'VAEDecodeAudio', 'CreateVideo', 'SaveVideo',
}


def ws_send(cid, msg_type, data):
    payload = json.dumps({'type': msg_type, 'data': data}).encode()
    n = len(payload)
    if n < 126:
        header = bytes([0x81, n])
    elif n < 65536:
        header = bytes([0x81, 126]) + struct.pack('>H', n)
    else:
        header = bytes([0x81, 127]) + struct.pack('>Q', n)
    with lock:
        s = sockets.get(cid)
    if s is None:
        return
    try:
        s.sendall(header + payload)
    except OSError:
        with lock:
            sockets.pop(cid, None)


def validate(prompt):
    """像真 ComfyUI 那样在排队前校验;不合格回 400"""
    if not isinstance(prompt, dict) or not prompt:
        return 'prompt 不是非空对象'
    types = {n.get('class_type') for n in prompt.values() if isinstance(n, dict)}
    if not REQUIRED <= types:
        return f'缺节点:{sorted(REQUIRED - types)}'
    i2v = next(n for n in prompt.values() if n.get('class_type') == 'MiniMaxH3ImageToVideo')['inputs']
    length = i2v.get('length')
    if not isinstance(length, int) or length < 5 or length % 17 != 5:
        return f'length {length!r} 不在 17k+5 网格上'
    if not isinstance(i2v.get('prompt'), str) or not i2v['prompt'].strip():
        return '提示词为空'
    return None


def fail(prompt_id, prompt):
    history[prompt_id] = {'prompt': [0, prompt_id, prompt, {}, []], 'outputs': {},
                          'status': {'status_str': 'error', 'completed': False, 'messages': []}}


def run_job(prompt_id, prompt, cid, extra_pnginfo):
    busy['on'] = True
    try:
        i2v = next(n for n in prompt.values() if n.get('class_type') == 'MiniMaxH3ImageToVideo')['inputs']
        frames, width, height = i2v['length'], i2v['width'], i2v['height']
        ws_send(cid, 'execution_start', {'prompt_id': prompt_id})
        for node in ['140:127', '140:128', '140:119', '140:120', '140:131']:
            ws_send(cid, 'executing', {'node': node, 'display_node': node, 'prompt_id': prompt_id})
            time.sleep(STEP_S / 3)
        ws_send(cid, 'executing', {'node': '140:125', 'display_node': '140:125', 'prompt_id': prompt_id})
        for step in range(1, STEPS + 1):
            if interrupted.is_set():
                fail(prompt_id, prompt)
                ws_send(cid, 'execution_interrupted', {'prompt_id': prompt_id, 'node_id': '140:125'})
                return
            time.sleep(STEP_S)
            ws_send(cid, 'progress', {'value': step, 'max': STEPS, 'prompt_id': prompt_id, 'node': '140:125'})
        counter['n'] += 1
        sub = 'video'
        name = f'MiniMax_H3_{counter["n"]:05d}_.mp4'
        os.makedirs(os.path.join(OUTPUT_DIR, sub), exist_ok=True)
        out = os.path.join(OUTPUT_DIR, sub, name)
        cmd = [os.environ.get('FAKE_COMFY_FFMPEG', 'ffmpeg'), '-hide_banner', '-loglevel', 'error', '-y',
               '-f', 'lavfi', '-i', f'testsrc=size={width}x{height}:rate=24',
               '-frames:v', str(frames), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast']
        # 同真 SaveVideo:extra_pnginfo 的每个键写成容器元数据,值经 json.dumps
        for k, v in (extra_pnginfo or {}).items():
            cmd += ['-metadata', f'{k}={json.dumps(v)}']
        cmd += [out]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            fail(prompt_id, prompt)
            ws_send(cid, 'execution_error', {'prompt_id': prompt_id, 'node_id': '92', 'exception_message': r.stderr[-500:]})
            return
        output = {'images': [{'filename': name, 'subfolder': sub, 'type': 'output'}], 'animated': [True]}
        ws_send(cid, 'executed', {'node': '92', 'display_node': '92', 'output': output, 'prompt_id': prompt_id})
        history[prompt_id] = {'prompt': [0, prompt_id, prompt, {}, ['92']], 'outputs': {'92': output},
                              'status': {'status_str': 'success', 'completed': True, 'messages': []}}
        ws_send(cid, 'execution_success', {'prompt_id': prompt_id})
        ws_send(cid, 'executing', {'node': None, 'prompt_id': prompt_id})
    finally:
        busy['on'] = False


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def send_body(self, code, body, ctype='application/json'):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('content-type', ctype)
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/ws':
            return self.upgrade(parse_qs(url.query).get('clientId', [''])[0])
        if url.path == '/system_stats':
            vram_used = 13.5 if busy['on'] else 0.4
            ram_used = 21.0 if busy['on'] else 3.0
            return self.send_body(200, {
                'system': {
                    'os': sys.platform,
                    'comfyui_version': '0.38.0',
                    'pytorch_version': '2.14.0+cu130',
                    'argv': sys.argv,
                    'ram_total': int(32 * GIB),
                    'ram_free': int((32 - ram_used) * GIB),
                    'vidroom_fake_replay': True,
                },
                'devices': [{'name': 'cpu', 'type': 'cpu', 'index': None,
                             'vram_total': int(16 * GIB), 'vram_free': int((16 - vram_used) * GIB)}],
            })
        if url.path.startswith('/history/'):
            pid = url.path[len('/history/'):]
            return self.send_body(200, {pid: history[pid]} if pid in history else {})
        if url.path == '/view':
            q = parse_qs(url.query)
            path = os.path.realpath(os.path.join(OUTPUT_DIR, q.get('subfolder', [''])[0], q.get('filename', [''])[0]))
            if not path.startswith(os.path.realpath(OUTPUT_DIR) + os.sep) or not os.path.isfile(path):
                return self.send_body(404, b'not found', 'text/plain')
            with open(path, 'rb') as f:
                return self.send_body(200, f.read(), 'video/mp4')
        return self.send_body(200, b'<!doctype html><title>Fake ComfyUI</title><h1>Fake ComfyUI</h1>', 'text/html')

    def do_POST(self):
        n = int(self.headers.get('content-length') or 0)
        raw = self.rfile.read(n) if n else b''
        if self.path == '/interrupt':
            interrupted.set()
            return self.send_body(200, b'', 'text/plain')
        if self.path != '/prompt':
            return self.send_body(404, b'not found', 'text/plain')
        body = json.loads(raw or b'{}')
        log = os.environ.get('FAKE_COMFY_REQUEST_LOG')
        if log:
            with open(log, 'a', encoding='utf-8') as f:
                f.write(json.dumps(body, ensure_ascii=False) + '\n')
        prompt = body.get('prompt')
        err = validate(prompt)
        if err:
            return self.send_body(400, {'error': {'type': 'prompt_outputs_failed_validation', 'message': err,
                                                  'details': '', 'extra_info': {}}, 'node_errors': {}})
        interrupted.clear()
        prompt_id = str(uuid.uuid4())
        threading.Thread(target=run_job, daemon=True, args=(
            prompt_id, prompt, body.get('client_id', ''), (body.get('extra_data') or {}).get('extra_pnginfo'))).start()
        return self.send_body(200, {'prompt_id': prompt_id, 'number': counter['n'], 'node_errors': {}})

    def upgrade(self, cid):
        key = self.headers.get('Sec-WebSocket-Key', '')
        accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        self.send_response(101)
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', accept)
        self.end_headers()
        self.wfile.flush()
        with lock:
            sockets[cid] = self.connection
        ws_send(cid, 'status', {'status': {'exec_info': {'queue_remaining': 0}}, 'sid': cid})
        # 客户端发来的帧一律不理,读到连接断开为止
        try:
            while self.connection.recv(4096):
                pass
        except OSError:
            pass
        with lock:
            if sockets.get(cid) is self.connection:
                sockets.pop(cid, None)
        self.close_connection = True

    def log_message(self, *a):
        pass


if os.environ.get('FAKE_COMFY_IGNORE_STOP') == '1':
    signal.signal(signal.SIGINT, signal.SIG_IGN)

if os.environ.get('FAKE_COMFY_EAT_MEMORY_MB'):
    def eat():
        hog, step = [], int(os.environ['FAKE_COMFY_EAT_MEMORY_MB'])
        time.sleep(2)
        while True:
            hog.append(bytearray(step * 1024 * 1024))  # bytearray 会写零,真提交内存
            print(f'[fake-comfy] 已占 {len(hog) * step} MiB', flush=True)
            time.sleep(0.1)
    threading.Thread(target=eat, daemon=True).start()

server = ThreadingHTTPServer((args.listen, args.port), Handler)
server.daemon_threads = True
print(f'To see the GUI go to: http://{args.listen}:{args.port}', flush=True)
try:
    server.serve_forever(poll_interval=0.2)
except KeyboardInterrupt:
    print('\nStopped server', flush=True)
