import { assert, vi } from 'vitest'

export const provider = 'https://rpc.invalid'

export type RPCRequest = {
  id: number
  method: string
  params: (string | string[] | boolean | number)[]
}

/** Exercise the real JSON-RPC transport without network or module mocks. */
export function mockRPC(handle: (request: RPCRequest) => unknown | Promise<unknown>) {
  const requests: RPCRequest[] = []
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    assert.strictEqual(url, provider)
    assert.strictEqual(init?.method, 'POST')
    const request = JSON.parse(init!.body as string) as RPCRequest
    requests.push(request)
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: request.id, result: await handle(request) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return { requests, fetchMock }
}
