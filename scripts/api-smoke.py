#!/usr/bin/env python3
"""Real HTTP contract smoke test. Start an isolated API before running this script."""
import argparse
import hashlib
import http.client
import json
import uuid
from urllib.parse import urlsplit

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:18080')
parser.add_argument('--origin', default='http://localhost:5173')
parser.add_argument('--file-bytes', type=int, default=200000, help='Use >1048576 to exercise disk storage.')
parser.add_argument('--validate-contract', action='store_true', help='Validate JSON responses against OpenAPI (requires jsonschema).')
args = parser.parse_args()
url = urlsplit(args.url)

if args.validate_contract:
    from contract_validator import validate_response, validate_request, validate_event
else:
    def validate_response(*args): pass
    def validate_request(*args): pass
    def validate_event(*args): pass

def connection():
    cls = http.client.HTTPSConnection if url.scheme == 'https' else http.client.HTTPConnection
    return cls(url.hostname, url.port, timeout=10)

class Client:
    def __init__(self, name):
        self.cookie = None
        self.csrf = None
        status, headers, result = self.request('POST', '/api/v1/sessions', {'displayName': name}, expected=201)
        self.cookie = headers['set-cookie'].split(';')[0]
        self.csrf = result['data']['csrfToken']
    def request(self, method, path, value=None, expected=200, headers=None, raw=None):
        h = {'Origin': args.origin}
        if self.cookie: h['Cookie'] = self.cookie
        if self.csrf: h['X-CSRF-Token'] = self.csrf
        if headers: h.update(headers)
        data = raw
        if value is not None:
            if expected < 400: validate_request(method, path, value)
            data = json.dumps(value, ensure_ascii=False).encode()
            h['Content-Type'] = 'application/json'
        conn = connection()
        conn.request(method, path, body=data, headers=h)
        response = conn.getresponse()
        payload = response.read()
        status = response.status
        meta = {k.lower(): v for k, v in response.getheaders()}
        conn.close()
        assert status == expected, (method, path, status, payload)
        result = json.loads(payload) if payload and 'application/json' in meta.get('content-type', '') else payload
        validate_response(method, path, status, result)
        return status, meta, result
    def room(self, code=None, join=False, password=None, expected=201):
        key = str(uuid.uuid4())
        challenge_request = {'action': 'room.join' if join else 'room.create', 'idempotencyKey': key}
        if code is not None: challenge_request['code'] = code
        challenge = self.request('POST', '/api/v1/pow/challenges', challenge_request, 201)[2]['data']
        nonce = 0
        while int.from_bytes(hashlib.sha256((challenge['input'] + str(nonce)).encode()).digest(), 'big') >> (256-challenge['difficulty']):
            nonce += 1
        body = {'proof': {'challengeId': challenge['challengeId'], 'nonce': str(nonce)}}
        if code is not None: body['code'] = code
        if password is not None: body['password'] = password
        path = '/api/v1/rooms/join' if join else '/api/v1/rooms'
        result = self.request('POST', path, body, expected, {'Idempotency-Key': key})[2]
        if expected >= 400: return result
        assert self.request('POST', path, body, 201, {'Idempotency-Key': key})[2] == result
        return result['data']
    def post(self, path, body, expected=201):
        return self.request('POST', path, body, expected, {'Idempotency-Key': str(uuid.uuid4())})[2]['data']

owner = Client('界' * 26 + 'ab')
owner.request('POST', '/api/v1/sessions', {'displayName': '界' * 27}, expected=400)
owner.request('GET', '/api/v1/capabilities')
owner.request('POST', '/api/v1/pow/challenges', {'action':'room.create','idempotencyKey':'bad key with spaces'}, expected=400)
guest = Client('Phone')
room = owner.room(password='private room 🔑')['room']
assert room['hasPassword'] is True
rid = room['id']
assert guest.room(room['code'], join=True, expected=403)['error']['code'] == 'ROOM_PASSWORD_INVALID'
member = guest.room(room['code'], join=True, password='private room 🔑')['membership']
try:
    guest.request('PATCH', f'/api/v1/rooms/{rid}', {'password':None}, expected=403)
    assert owner.request('PATCH', f'/api/v1/rooms/{rid}', {'password':'replacement'})[2]['data']['hasPassword'] is True
    assert owner.request('PATCH', f'/api/v1/rooms/{rid}', {'password':None})[2]['data']['hasPassword'] is False
    text = owner.post(f'/api/v1/rooms/{rid}/items', {'text': 'Hello\n你好 WebDrop'})
    items = guest.request('GET', f'/api/v1/rooms/{rid}/items')[2]
    assert items['data'][0] == text
    guest.request('DELETE', f'/api/v1/rooms/{rid}/items/{text["id"]}', expected=403)
    owner.request('POST', f'/api/v1/rooms/{rid}/items', {'text':'blocked'}, expected=403,
                  headers={'X-CSRF-Token':'invalid','Idempotency-Key':str(uuid.uuid4())})
    assert 20 <= args.file_bytes <= 100000000
    payload = (b'0123456789' * ((args.file_bytes + 9) // 10))[:args.file_bytes]
    upload = owner.post(f'/api/v1/rooms/{rid}/uploads', {'filename':'hello.txt','sizeBytes':len(payload),'contentType':'text/plain'})
    owner.request('PUT', upload['uploadUrl'], raw=payload)
    status_path = '/api/v1/uploads/' + upload['uploadId']
    assert owner.request('GET', status_path)[2]['data']['status'] == 'uploaded'
    guest.request('GET', status_path, expected=403)
    item = owner.post('/api/v1/uploads/'+upload['uploadId']+'/complete', {})
    asset = item['asset']
    assert owner.request('GET', status_path)[2]['data']['itemId'] == item['id']
    assert asset['sha256'] == hashlib.sha256(payload).hexdigest()
    assert asset['contentType'] == 'application/octet-stream'
    path = '/api/v1/assets/'+asset['id']+'/content'
    assert guest.request('GET', path)[2] == payload
    assert guest.request('GET', path, expected=206, headers={'Range':'bytes=10-19'})[2] == payload[10:20]
    assert guest.request('GET', path, expected=206, headers={'Range':'bytes=-5'})[2] == payload[-5:]
    guest.request('GET', path, expected=416, headers={'Range':'bytes=99999999-'})
    _, headers, body = guest.request('HEAD', path)
    assert headers['content-length'] == str(len(payload)) and body == b''
    link = owner.post('/api/v1/assets/'+asset['id']+'/links', {})
    public_path = '/d/' + link['slug']
    conn = connection(); conn.request('GET', public_path); response = conn.getresponse()
    assert response.status == 200 and response.read() == payload; conn.close()
    # Replay from a snapshot cursor must include the later event and be readable as SSE.
    cursor = owner.request('GET', f'/api/v1/rooms/{rid}')[2]['data']['eventCursor']
    second = owner.post(f'/api/v1/rooms/{rid}/items', {'text':'SSE test'})
    conn = connection(); conn.request('GET', f'/api/v1/rooms/{rid}/events?cursor={cursor}', headers={'Cookie':owner.cookie})
    response = conn.getresponse(); assert response.status == 200
    lines = [response.readline().decode() for _ in range(4)]
    assert any('event: item.created' in line for line in lines), lines
    assert any(second['id'] in line for line in lines), lines
    event_data = json.loads(next(line[6:] for line in lines if line.startswith('data: ')))
    validate_event('item.created', event_data)
    heartbeat = [response.readline().decode() for _ in range(4)]
    assert 'event: heartbeat\n' in heartbeat, heartbeat
    validate_event('heartbeat', json.loads(next(line[6:] for line in heartbeat if line.startswith('data: '))))
    conn.close()
    owner.request('DELETE', f'/api/v1/rooms/{rid}/members/{member["id"]}', expected=204)
    guest.request('GET', path, expected=404)
    guest.request('GET', f'/api/v1/rooms/{rid}/events', expected=404)
    owner.request('DELETE', f'/api/v1/rooms/{rid}', expected=204)
    owner.request('GET', public_path, expected=410)
    print('PASS: room passwords, sessions, CSRF, PoW, idempotency, room permissions, chat, streaming upload, SHA256, Range/HEAD, public links, SSE, kick and close revocation')
except BaseException:
    try: owner.request('DELETE', f'/api/v1/rooms/{rid}', expected=204)
    except Exception: pass
    raise
