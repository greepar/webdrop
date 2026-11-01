#!/usr/bin/env python3
"""Verify OCI startup, frontend/API, persistent sessions and SIGTERM with Podman."""
import argparse
import http.client
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', default='localhost/webdrop:check')
parser.add_argument('--validate-contract', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
name = 'webdrop-check-' + uuid.uuid4().hex[:12]
volume = name + '-data'


def podman(*arguments, check=True):
    return subprocess.run(['podman', *arguments], check=check, text=True, capture_output=True)


def start():
    podman('run', '-d', '--name', name, '--read-only', '--cap-drop=all', '--security-opt=no-new-privileges',
           '-p', '127.0.0.1::8080', '-v', volume + ':/data', args.image)
    binding = json.loads(podman('inspect', name).stdout)[0]['NetworkSettings']['Ports']['8080/tcp'][0]
    port = int(binding['HostPort'])
    for _ in range(200):
        try:
            if request(port, 'GET', '/health')[0] == 200:
                return port
        except OSError:
            pass
        time.sleep(.05)
    raise RuntimeError('OCI startup timeout: ' + podman('logs', name).stdout)


def request(port, method, path, body=None, cookie=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    headers = {'Origin': f'http://127.0.0.1:{port}'}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    if cookie:
        headers['Cookie'] = cookie
    connection.request(method, path, json.dumps(body) if body is not None else None, headers)
    response = connection.getresponse()
    result = response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
    connection.close()
    return result


try:
    podman('volume', 'create', volume)
    port = start()
    assert podman('exec', name, '/bin/cat', '/etc/alpine-release').stdout.strip() == '3.24.3'
    assert b'<html' in request(port, 'GET', '/')[2]
    assert request(port, 'GET', '/api/v1/missing')[0] == 404
    assert request(port, 'GET', '/d/missing')[0] == 404
    for size in (200000, 2000000):
        command = [sys.executable, str(root / 'scripts/api-smoke.py'), '--url', f'http://127.0.0.1:{port}', '--file-bytes', str(size)]
        if args.validate_contract:
            command.append('--validate-contract')
        subprocess.run(command, check=True)
    status, headers, payload = request(port, 'POST', '/api/v1/sessions', {'displayName': 'container-persist'})
    assert status == 201, payload
    device = json.loads(payload)['data']['deviceId']
    cookie = headers['set-cookie'].split(';')[0]
    before = time.monotonic()
    podman('stop', '--time', '5', name)
    assert time.monotonic() - before < 5
    state = json.loads(podman('inspect', name).stdout)[0]['State']
    assert state['ExitCode'] == 0, state
    assert 'Server stop took too long' not in podman('logs', name).stdout
    podman('rm', name)
    port = start()
    status, _, payload = request(port, 'GET', '/api/v1/session', cookie=cookie)
    assert status == 200 and json.loads(payload)['data']['deviceId'] == device
    print('PASS Alpine OCI read-only/non-root startup, embedded frontend, memory/disk HTTP, volume recovery and SIGTERM')
finally:
    podman('rm', '-f', name, check=False)
    podman('volume', 'rm', '-f', volume, check=False)
