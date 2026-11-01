#!/usr/bin/env python3
"""Run browser checks against disposable local services, without touching preview data."""
import argparse
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parents[2]


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def ready(url, processes):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if any(process.poll() is not None for process in processes):
            raise RuntimeError('Test service exited during startup')
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(0.1)
    raise RuntimeError(f'Startup timeout: {url}')


def stop(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=3)


def run(script, cross_origin=False):
    binary = Path(os.environ.get('WEBDROP_API_BINARY', ROOT / 'apps/api/.build/debug/webdrop')).resolve()
    if not binary.is_file():
        raise RuntimeError('Build the API first: npm run build:api')
    test = (TESTS / script).resolve()
    if test.parent != TESTS or not test.is_file() or test.suffix != '.mjs':
        raise RuntimeError(f'Unknown browser check: {script}')
    with tempfile.TemporaryDirectory(prefix='webdrop-check-') as temporary:
        backend_port, frontend_port = port(), port()
        while frontend_port == backend_port:
            frontend_port = port()
        url = f'http://127.0.0.1:{frontend_port}'
        env = os.environ.copy()
        env.update(DATA_DIR=str(Path(temporary) / 'data'),
                   VITE_API_MODE='live', API_PROXY_TARGET=f'http://127.0.0.1:{backend_port}',
                   WEBDROP_TEST_URL=url,
                   CORS_ALLOWED_ORIGINS=url if cross_origin else '',
                   VITE_API_BASE_URL=f'http://127.0.0.1:{backend_port}/api/v1' if cross_origin else '/api/v1')
        # Explicit config for this disposable service: bypass interactive first-run setup
        # without creating or changing a developer's repository .env.
        (Path(temporary) / '.env').write_text('# Test configuration is supplied through process environment.\n')
        processes = []
        log_path = Path(temporary) / 'services.log'
        try:
            with log_path.open('w') as log:
                processes.append(subprocess.Popen([str(binary), 'serve', '--hostname', '127.0.0.1', '--port', str(backend_port)], cwd=temporary, env=env, stdout=log, stderr=log, start_new_session=True))
                processes.append(subprocess.Popen(['npm', 'run', 'dev:web', '--', '--host', '127.0.0.1', '--port', str(frontend_port)], cwd=ROOT, env=env, stdout=log, stderr=log, start_new_session=True))
                ready(f'{url}/api/v1/capabilities', processes)
                print(f'CHECK {test.name} at {url} (disposable data)', flush=True)
                check = subprocess.Popen(['node', str(test)], cwd=ROOT, env=env, start_new_session=True)
                processes.append(check)
                code = check.wait(timeout=180)
                if code:
                    raise RuntimeError(f'{test.name} failed with exit {code}')
        except Exception:
            print(log_path.read_text()[-3000:], flush=True)
            raise
        finally:
            for process in reversed(processes):
                stop(process)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('scripts', nargs='+', help='Check filenames in apps/web/tests; each gets fresh services')
    parser.add_argument('--cross-origin', action='store_true', help='Use a separate API origin and explicit CORS allowlist')
    args = parser.parse_args()
    for script in args.scripts:
        run(script, args.cross_origin)


if __name__ == '__main__':
    main()
