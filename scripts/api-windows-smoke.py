#!/usr/bin/env python3
"""Start the packaged Windows executable with only its adjacent runtime DLLs."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', type=Path, required=True)
args = parser.parse_args()
binary = args.binary.resolve()
with tempfile.TemporaryDirectory(prefix='webdrop-windows-') as temporary:
    work = Path(temporary)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    environment = os.environ.copy()
    environment.update(API_HOST='127.0.0.1', API_PORT=str(port), DATA_DIR=str(work / 'data'))
    environment['PATH'] = str(binary.parent) + os.pathsep + str(Path(os.environ['SystemRoot']) / 'System32')
    first = subprocess.run([str(binary)], cwd=work, env=environment, capture_output=True, timeout=20)
    assert first.returncode == 0, (first.returncode, first.stdout, first.stderr)
    assert (work / '.env').is_file() and not (work / 'data').exists()
    with (work / 'server.log').open('w+') as log:
        process = subprocess.Popen([str(binary)], cwd=work, env=environment, stdout=log, stderr=log)
        try:
            origin = f'http://127.0.0.1:{port}'
            for _ in range(200):
                if process.poll() is not None:
                    raise RuntimeError((work / 'server.log').read_text())
                try:
                    if urllib.request.urlopen(origin + '/health', timeout=1).status == 200:
                        break
                except (OSError, urllib.error.URLError):
                    time.sleep(.1)
            else:
                raise RuntimeError('Windows startup timeout')
            page = urllib.request.urlopen(origin).read()
            assert b'<html' in page
            request = urllib.request.Request(origin + '/api/v1/sessions', data=b'{}', headers={'Origin': origin, 'Content-Type':'application/json'})
            with urllib.request.urlopen(request) as response:
                assert response.status == 201
                assert json.load(response)['data']['csrfToken']
            for size in (200000, 2000000):
                subprocess.run([
                    sys.executable, str(Path(__file__).with_name('api-smoke.py').resolve()),
                    '--url', origin, '--file-bytes', str(size),
                ], env=environment, check=True, timeout=120)
            print('PASS Windows packaged exe, first launch, frontend, permissions, SSE and memory/disk upload with isolated DLL PATH')
        finally:
            process.terminate()
            process.wait(timeout=10)
