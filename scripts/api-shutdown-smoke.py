#!/usr/bin/env python3
"""Real HTTP approval-event and SIGINT/SIGTERM shutdown checks using disposable data."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent


def run(binary, validate_contract):
    if validate_contract:
        from contract_validator import validate_event, validate_request, validate_response
    else:
        def validate_event(kind, data):
            pass
        def validate_request(*args):
            pass
        def validate_response(*args):
            pass
    with tempfile.TemporaryDirectory(prefix='webdrop-shutdown-') as directory:
        work = Path(directory)
        (work / '.env').write_text('# Isolated shutdown test.\n')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        environment = dict(os.environ, DATA_DIR=str(work / 'data'), API_PORT=str(port), CORS_ALLOWED_ORIGINS='')
        streams = []
        process = None
        with (work / 'server.log').open('w+') as log:
            def start():
                process = subprocess.Popen([str(binary), 'serve', '--hostname', '127.0.0.1', '--port', str(port)],
                                           cwd=work, env=environment, stdout=log, stderr=log)
                for _ in range(200):
                    if process.poll() is not None:
                        raise RuntimeError('Backend exited during startup')
                    try:
                        status, _, _ = request('GET', '/health')
                        if status == 200:
                            return process
                    except OSError:
                        pass
                    time.sleep(.05)
                raise RuntimeError('Backend startup timed out')

            def request(method, path, value=None, user=None, key=None):
                headers = {'Origin': origin}
                if user:
                    headers.update(Cookie=user['cookie'], **{'X-CSRF-Token': user['csrf']})
                if key:
                    headers['Idempotency-Key'] = key
                if value is not None:
                    headers['Content-Type'] = 'application/json'
                    validate_request(method, path, value)
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                connection.request(method, path, json.dumps(value) if value is not None else None, headers)
                response = connection.getresponse()
                body = response.read()
                result = (response.status, {k.lower(): v for k, v in response.getheaders()}, json.loads(body) if body else None)
                connection.close()
                validate_response(method, path, result[0], result[2])
                return result

            def user(name):
                status, headers, body = request('POST', '/api/v1/sessions', {'displayName': name})
                assert status == 201, (status, body)
                return {'cookie': headers['set-cookie'].split(';')[0], 'csrf': body['data']['csrfToken']}

            def proved(user, code=None):
                key = str(uuid.uuid4())
                value = {'action': 'room.join' if code else 'room.create', 'idempotencyKey': key}
                if code:
                    value['code'] = code
                status, _, body = request('POST', '/api/v1/pow/challenges', value, user)
                assert status == 201, (status, body)
                challenge = body['data']
                nonce = 0
                while int.from_bytes(hashlib.sha256((challenge['input'] + str(nonce)).encode()).digest(), 'big') >> (256 - challenge['difficulty']):
                    nonce += 1
                value = {'proof': {'challengeId': challenge['challengeId'], 'nonce': str(nonce)}}
                if code:
                    value['code'] = code
                return value, key

            def frame(response):
                fields = {}
                while True:
                    line = response.readline().decode().rstrip('\r\n')
                    if not line:
                        assert fields, 'SSE ended unexpectedly'
                        return fields
                    name, _, value = line.partition(':')
                    fields[name] = value.lstrip()

            def event(response, kind):
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    fields = frame(response)
                    if fields['event'] == kind:
                        data = json.loads(fields['data'])
                        assert fields['id'] == data['eventId'] and data['type'] == kind
                        validate_event(kind, data)
                        return data
                raise AssertionError(f'Missing SSE event: {kind}')

            def subscribe(user, room, cursor):
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                connection.request('GET', f'/api/v1/rooms/{room}/events?cursor={cursor}', headers={'Cookie': user['cookie']})
                response = connection.getresponse()
                assert response.status == 200
                streams.append((connection, response))
                # Waiting for the first heartbeat confirms this request is inside the long-lived loop.
                while frame(response).get('event') != 'heartbeat':
                    pass
                return response

            def stop(process, code):
                started = time.monotonic()
                process.send_signal(code)
                process.wait(timeout=5)
                elapsed = time.monotonic() - started
                assert process.returncode == 0, process.returncode
                assert elapsed < 3, f'Shutdown took {elapsed:.3f}s'
                for connection, response in streams:
                    assert b'event: room.closed' not in response.read(), 'Process shutdown must not close the room'
                    connection.close()
                streams.clear()
                log.flush()
                assert 'Server stop took too long' not in (work / 'server.log').read_text()
                print(f'PASS {signal.Signals(code).name}: active SSE drained in {elapsed:.3f}s', flush=True)

            try:
                process = start()
                owner, applicant = user('shutdown-owner'), user('shutdown-applicant')
                status, _, renamed = request('PATCH', '/api/v1/session', {'displayName':'renamed-owner'}, owner)
                assert status == 200 and renamed['data']['displayName'] == 'renamed-owner'
                value, key = proved(owner)
                status, _, body = request('POST', '/api/v1/rooms', value, owner, key)
                assert status == 201, (status, body)
                room, code = body['data']['room']['id'], body['data']['room']['code']
                assert request('PATCH', f'/api/v1/rooms/{room}', {'approvalRequired': True}, owner)[0] == 200
                cursor = request('GET', f'/api/v1/rooms/{room}', user=owner)[2]['data']['eventCursor']
                response = subscribe(owner, room, cursor)
                value, key = proved(applicant, code)
                status, _, body = request('POST', '/api/v1/rooms/join', value, applicant, key)
                assert status == 202, (status, body)
                pending = body['data']['request']
                created = event(response, 'join-request.created')
                assert created['data'] == pending
                assert request('GET', f'/api/v1/rooms/{room}/events', user=applicant)[0] == 404
                path = f'/api/v1/rooms/{room}/join-requests/{pending["id"]}'
                assert request('DELETE', path, user=owner)[0] == 403
                assert request('DELETE', path, user=applicant)[0] == 204
                withdrawn = event(response, 'join-request.updated')
                assert withdrawn['data']['status'] == 'withdrawn'
                assert request('DELETE', path, user=applicant)[0] == 409
                assert request('GET', f'/api/v1/rooms/{room}/join-requests', user=owner)[2]['data'] == []
                value, key = proved(applicant, code)
                status, _, body = request('POST', '/api/v1/rooms/join', value, applicant, key)
                assert status == 202
                pending = body['data']['request']
                assert event(response, 'join-request.created')['data'] == pending
                path = f'/api/v1/rooms/{room}/join-requests/{pending["id"]}'
                status, _, body = request('POST', path + '/approve', {}, owner)
                assert status == 200, (status, body)
                approved = event(response, 'join-request.updated')
                assert approved['data'] == body['data'] and approved['data']['status'] == 'approved'
                print('PASS session rename and real SSE created/withdrawn/approved schema; pending-applicant exclusion', flush=True)
                cursor = approved['eventId']
                subscribe(owner, room, cursor)
                subscribe(owner, room, cursor)
                subscribe(applicant, room, cursor)
                stop(process, signal.SIGINT)
                snapshot = json.loads((work / 'data/state.json').read_text())
                assert snapshot['rooms'][room].get('closed') is None
                assert len(snapshot['rooms'][room]['members']) == 2
                process = start()
                status, _, recovered = request('GET', '/api/v1/session', user=owner)
                assert status == 200 and recovered['data']['memberships'][0]['membership']['role'] == 'owner'
                assert request('GET', f'/api/v1/rooms/{room}', user=owner)[0] == 200
                subscribe(owner, room, cursor)
                stop(process, signal.SIGTERM)
                print('PASS restart keeps owner, membership and room; shutdown emits no room.closed', flush=True)
            except BaseException:
                log.flush()
                print((work / 'server.log').read_text()[-3000:])
                raise
            finally:
                if process is not None and process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                for connection, _ in streams:
                    connection.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=ROOT / 'apps/api/.build/debug/webdrop')
    parser.add_argument('--validate-contract', action='store_true')
    arguments = parser.parse_args()
    run(arguments.binary.resolve(), arguments.validate_contract)
