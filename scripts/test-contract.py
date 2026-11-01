"""Offline contract checks. Run with the same Python environment as --validate-contract."""
import unittest
from contract_validator import SPEC, Validator, validate, validate_event
from jsonschema import ValidationError


class ContractTests(unittest.TestCase):
    def test_schemas_and_refs(self):
        for schema in SPEC['components']['schemas'].values():
            Validator.check_schema(schema)
        def walk(value):
            if isinstance(value, dict):
                if '$ref' in value:
                    target = SPEC
                    for part in value['$ref'].removeprefix('#/').split('/'):
                        target = target[part]
                for child in value.values(): walk(child)
            elif isinstance(value, list):
                for child in value: walk(child)
        walk(SPEC)

    def test_utf8_boundary(self):
        schema = {'$ref':'#/components/schemas/CreateSession'}
        validate(schema, {'displayName': '界' * 26 + 'ab'})
        validate(schema, {'displayName': None})
        with self.assertRaises(ValidationError): validate(schema, {'displayName': '界' * 27})

    def test_event_discriminator_and_formats(self):
        event = {'eventId':'1','type':'item.deleted','roomId':'00000000-0000-4000-8000-000000000000',
                 'occurredAt':'2026-11-01T00:00:00Z','data':{'id':'00000000-0000-4000-8000-000000000001'}}
        validate_event('item.deleted', event)
        for patch in ({'data':{'anything':True}}, {'occurredAt':'yesterday'}, {'type':'item.created'}):
            with self.assertRaises(ValidationError): validate_event('item.deleted', {**event, **patch})
        with self.assertRaises(AssertionError): validate_event('member.left', event)
        validate_event('resync.required', {'eventCursor':'256'})

    def test_error_enum_and_request_constraints(self):
        schema = SPEC['paths']['/api/v1/rooms']['post']['responses']['409']['content']['application/json']['schema']
        error = {'error':{'code':'CODE_TAKEN','message':'Occupied','requestId':'00000000-0000-4000-8000-000000000000'}}
        validate(schema,error)
        error['error']['code']='ROOM_FULL'
        with self.assertRaises(ValidationError): validate(schema,error)
        challenge = {'$ref':'#/components/schemas/ChallengeRequest'}
        with self.assertRaises(ValidationError): validate(challenge, {'action':'room.join','idempotencyKey':'12345678'})
        with self.assertRaises(ValidationError): validate(challenge, {'action':'room.create','idempotencyKey':'bad key!'})
        upload = {'filename':'ok.txt','sizeBytes':1,'contentType':'text/plain'}
        for filename in ('..','a/b','a\\b','bad\x00name','界'*81):
            with self.assertRaises(ValidationError): validate({'$ref':'#/components/schemas/CreateUpload'}, {**upload,'filename':filename})

    def test_room_password_contract(self):
        schema = {'$ref':'#/components/schemas/UpdateRoom'}
        for value in ({'password':None}, {'password':'界'*24}, {'joinPolicy':'locked','password':' abc '}): validate(schema,value)
        for value in ({}, {'password':''}, {'password':'界'*25}, {'password':'a\x00b'}, {'password':123}):
            with self.assertRaises(ValidationError): validate(schema,value)
        # The new field is mandatory on Room, including room.updated payloads.
        self.assertIn('hasPassword', SPEC['components']['schemas']['Room']['required'])


if __name__ == '__main__': unittest.main()
