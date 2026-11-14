/**
 * Exhaustiveness guard for closed discriminated unions owned by TTDS.
 * @param value - unreachable discriminant value after exhaustive switch branches.
 * @param label - optional diagnostic subject naming the union or switch site.
 * @returns never returns; always throws an Error naming the unexpected value.
 */
export function assertNever(value: never, label = 'unexpected discriminated value'): never {
  throw new Error(`ttds: ${label}: ${JSON.stringify(value)}`)
}
