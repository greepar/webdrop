// Minimal runtime checks for responses. Anything that does not match the contract is a client-side
// contract violation and is surfaced as an error instead of being rendered.

export class ContractError extends Error {
  constructor(where: string) {
    super(`Unexpected response: ${where}`)
    this.name = 'ContractError'
  }
}

type Json = Record<string, unknown>

export function asObject(value: unknown, where: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ContractError(where)
  return value as Json
}

export function asString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new ContractError(where)
  return value
}

export function asNullableString(value: unknown, where: string): string | null {
  if (value === null) return null
  return asString(value, where)
}

export function asNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ContractError(where)
  return value
}

export function asBoolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') throw new ContractError(where)
  return value
}

export function asOneOf<const T extends string>(value: unknown, options: readonly T[], where: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new ContractError(where)
  return value as T
}

export function asArray<T>(value: unknown, where: string, parse: (item: unknown, index: number) => T): T[] {
  if (!Array.isArray(value)) throw new ContractError(where)
  return value.map((item, index) => parse(item, index))
}

export function unwrapData(payload: unknown, where: string): unknown {
  return asObject(payload, where).data
}

export function unwrapList(payload: unknown, where: string) {
  const body = asObject(payload, where)
  const page = asObject(body.page, `${where}.page`)
  return { data: body.data, nextCursor: asNullableString(page.nextCursor, `${where}.page.nextCursor`) }
}
