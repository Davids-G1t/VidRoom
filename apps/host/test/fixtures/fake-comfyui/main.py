"""假 ComfyUI:只认 --listen / --port,回 /system_stats 和首页,给单测和 e2e 用(不需要 PyTorch、不需要显卡)。

FAKE_COMFY_IGNORE_STOP=1 时忽略 Ctrl+C,用来测「不肯退就强杀」那条路。
"""
import argparse
import json
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

parser = argparse.ArgumentParser()
parser.add_argument('--listen', default='127.0.0.1')
parser.add_argument('--port', type=int, default=8188)
args, _ = parser.parse_known_args()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/system_stats':
            body = json.dumps({
                'system': {
                    'os': sys.platform,
                    'comfyui_version': '0.38.0',
                    'pytorch_version': '2.14.0+cu130',
                    'argv': sys.argv,
                },
                'devices': [{'name': 'cpu', 'type': 'cpu', 'index': None}],
            }).encode()
            ctype = 'application/json'
        else:
            body = b'<!doctype html><title>Fake ComfyUI</title><h1>Fake ComfyUI</h1>'
            ctype = 'text/html'
        self.send_response(200)
        self.send_header('content-type', ctype)
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if os.environ.get('FAKE_COMFY_IGNORE_STOP') == '1':
    signal.signal(signal.SIGINT, signal.SIG_IGN)

server = ThreadingHTTPServer((args.listen, args.port), Handler)
print(f'To see the GUI go to: http://{args.listen}:{args.port}', flush=True)
try:
    server.serve_forever(poll_interval=0.2)
except KeyboardInterrupt:
    print('\nStopped server', flush=True)
