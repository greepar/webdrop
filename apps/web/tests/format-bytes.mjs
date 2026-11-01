// Byte formatting must match the server's decimal limits (100,000,000 bytes reads as 100 MB).
import assert from 'node:assert/strict'
import { formatBytes } from '../src/features/room/format.ts'

const cases = [
  [0, '0 B'],
  [24, '24 B'],
  [999, '999 B'],
  [1000, '1 KB'],
  [1500, '1.5 KB'],
  [100_000, '100 KB'],
  [100_000_000, '100 MB'],
  [1_500_000, '1.5 MB'],
  [2_000_000_000, '2 GB'],
]
for (const [bytes, expected] of cases) {
  assert.equal(formatBytes(bytes), expected, `${bytes} bytes`)
}
assert.equal(formatBytes(Number.NaN), '')
console.log(`PASS ${cases.length} byte formatting cases match decimal server limits`)
