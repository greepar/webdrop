"""OpenAPI 3.1 validation shared by offline checks and the HTTP smoke client."""
import json
import re
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker, ValidationError, validators
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[1]
SPEC = json.loads((ROOT / 'packages/contracts/openapi.yaml').read_text())
URI = 'urn:webdrop:openapi'


def utf8_limit(validator, limit, value, schema):
    if isinstance(value, str) and len(value.encode('utf-8')) > limit:
        yield ValidationError(f'UTF-8 value exceeds {limit} bytes')


Validator = validators.extend(Draft202012Validator, {'x-maxUtf8Bytes': utf8_limit})
REGISTRY = Registry().with_resource(URI, Resource.from_contents({
    '$schema': 'https://json-schema.org/draft/2020-12/schema', **SPEC,
}))


def absolute(value):
    if isinstance(value, dict):
        return {k: URI + v if k == '$ref' and v.startswith('#') else absolute(v) for k, v in value.items()}
    if isinstance(value, list):
        return [absolute(v) for v in value]
    return value


def validate(schema, value):
    Validator(absolute(schema), registry=REGISTRY, format_checker=FormatChecker()).validate(value)


def operation(method, path):
    for template, operations in SPEC['paths'].items():
        pattern = re.sub(r'\{[^}]+\}', '[^/]+', template)
        if re.fullmatch(pattern, path.split('?')[0]) and method.lower() in operations:
            return operations[method.lower()]
    raise AssertionError(('Undocumented operation', method, path))


def validate_response(method, path, status, result):
    responses = operation(method, path)['responses']
    # Business failures must be explicit; default is reserved for framework failures.
    assert str(status) in responses, ('Undocumented status', method, path, status)
    if isinstance(result, dict):
        validate(responses[str(status)]['content']['application/json']['schema'], result)


def validate_request(method, path, value):
    request = operation(method, path).get('requestBody')
    if request:
        validate(request['content']['application/json']['schema'], value)


def validate_event(event_type, data):
    media = SPEC['paths']['/api/v1/rooms/{roomId}/events']['get']['responses']['200']['content']['text/event-stream']
    validate(media['x-sse-events'][event_type], data)
    if event_type not in ('heartbeat', 'resync.required'):
        assert data['type'] == event_type, 'SSE event name and envelope type differ'
