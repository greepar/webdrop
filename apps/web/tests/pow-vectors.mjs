import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { meetsDifficulty, sha256Bytes, solve } from '../src/shared/pow/protocol.ts'
const vectors = JSON.parse(await readFile(new URL('../../../packages/contracts/pow-vectors.json', import.meta.url), 'utf8'))
for (const vector of vectors) {
  assert.equal(await meetsDifficulty(vector.input, vector.nonce, vector.difficulty), vector.valid)
  if (vector.sha256) assert.equal(Buffer.from(await sha256Bytes(vector.input + vector.nonce)).toString('hex'), vector.sha256)
}
assert.equal(await solve({ input: 'cancel', difficulty: 8 }, () => true), null)
assert.equal(await solve({ input: 'zero', difficulty: 0 }, () => false), '0')
console.log(`PASS ${vectors.length} official PoW vectors, immediate cancellation and zero difficulty`)
