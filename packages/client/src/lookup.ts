/**
 * A table whose keys arrive in the request. Without a prototype, a name that
 * `Object.prototype` carries — `constructor`, `toString`, `hasOwnProperty` —
 * misses like any other unknown key instead of reading back a function.
 */
export function requestKeyed<T extends object>(table: T): T {
  Object.setPrototypeOf(table, null)
  for (const value of Object.values(table)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      requestKeyed(value)
    }
  }
  return table
}
