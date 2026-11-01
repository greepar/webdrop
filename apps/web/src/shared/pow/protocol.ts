import { sha256 } from '@noble/hashes/sha2.js'

// Client PoW per packages/contracts/protocol.md (PoW v1). Hash input is the server-issued `input`
// string immediately followed by the decimal nonce, with no extra separator. Difficulty counts leading
// zero BITS of SHA-256. The nonce is kept as a string end to end; never coerce it to a JS number.

export type SolveInput = { input: string; difficulty: number; nonceLimit?: number }

const NONCE_PATTERN = /^(0|[1-9][0-9]{0,63})$/

export async function sha256Bytes(text: string): Promise<Uint8Array> {
  // LAN HTTP has no SubtleCrypto. SHA-256 here needs no secure-context APIs.
  return sha256(new TextEncoder().encode(text))
}

export function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8
      continue
    }
    bits += Math.clz32(byte) - 24
    break
  }
  return bits
}

export async function meetsDifficulty(input: string, nonce: string, difficulty: number): Promise<boolean> {
  if (!NONCE_PATTERN.test(nonce)) return false
  return leadingZeroBits(await sha256Bytes(input + nonce)) >= difficulty
}

// Searches nonces 0, 1, 2, … as decimal strings. Yields to the worker event loop between batches so
// the cancel message can be processed. Returns null if cancelled.
export async function solve(request: SolveInput, isCancelled: () => boolean): Promise<string | null> {
  const limit = request.nonceLimit ?? Number.MAX_SAFE_INTEGER
  for (let n = 0; n <= limit; n++) {
    if (n > 0 && n % 256 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (isCancelled()) return null
    const nonce = String(n)
    if (await meetsDifficulty(request.input, nonce, request.difficulty)) return nonce
  }
  throw new Error('nonce space exhausted')
}
