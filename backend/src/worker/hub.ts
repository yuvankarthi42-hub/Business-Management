// The live-update hub on Cloudflare: one Durable Object per shop, holding that shop's open screens as WebSockets.
// It runs the same Hub as the tests (events/hub.ts): staff screens with a signed ticket see their branches' changes,
// public screens (QR menu, TV board, order tracking) only "menu changed" / "your order changed". It never reads a
// database. Screens are accepted with the hibernation API, so a shop whose screens are open but quiet costs nothing
// while idle; after waking, the open sockets are handed back to the hub (each socket carries who it is).
//
// Only the Worker reaches this object (a Durable Object has no public address): /connect after the Worker checked
// the ticket, /publish with a request's events after its changes were saved.
import { Hub, type HubEvent, type HubMessage, type Listener, type Ticket } from '../events/hub'
import type { DurableObjectStateLike, HubSocket } from './types'

/** Who a socket is (kept on the socket, so it survives hibernation). */
export interface SocketInfo { shop: string; ticket: Ticket | null; orderId: string | null; device: string | null }

/** The WebSocket sub-protocol both sides name (the staff ticket travels as the second one, not in the address). */
export const LIVE_PROTOCOL = 'kk-live'

declare const WebSocketPair: { new (): { 0: WebSocket; 1: HubSocket } }
declare const WebSocketRequestResponsePair: { new (request: string, response: string): unknown } | undefined

export class ShopHub {
  private hub = new Hub()
  private bySocket = new Map<HubSocket, Listener>()

  constructor(private state: DurableObjectStateLike, _env: unknown) {
    // Screens' keep-alive "ping" is answered "pong" by Cloudflare itself — the hub isn't woken (or billed) for it.
    if (typeof WebSocketRequestResponsePair !== 'undefined') state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair('ping', 'pong'))
    for (const ws of state.getWebSockets()) {
      const info = ws.deserializeAttachment() as SocketInfo | null
      if (info) this.hub.restore(this.listener(ws, info))
    }
  }

  private listener(ws: HubSocket, info: SocketInfo): Listener {
    const l: Listener = {
      shop: info.shop, ticket: info.ticket, orderId: info.orderId, device: info.device,
      send: (m: HubMessage) => ws.send(JSON.stringify(m)),
      close: () => { try { ws.close(4401, 'reauth') } catch { /* gone */ } },
    }
    this.bySocket.set(ws, l)
    return l
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/publish' && request.method === 'POST') {
      let list: HubEvent[] = []
      try { list = (await request.json()) as HubEvent[] } catch { return new Response(null, { status: 400 }) }
      this.hub.publish(Array.isArray(list) ? list : [])
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/connect' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      let info: SocketInfo
      try { info = JSON.parse(request.headers.get('x-hub-listener') ?? '') as SocketInfo } catch { return new Response(null, { status: 400 }) }
      const pair = new WebSocketPair()
      const client = pair[0], server = pair[1]
      this.state.acceptWebSocket(server)
      server.serializeAttachment(info)
      this.hub.add(this.listener(server, info), url.searchParams.get('since'))
      return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': LIVE_PROTOCOL } } as ResponseInit & { webSocket: WebSocket })
    }
    return new Response(null, { status: 404 })
  }

  /** Screens only ever send "ping" (keep-alive through proxies). */
  webSocketMessage(ws: HubSocket, message: string | ArrayBuffer) { if (message === 'ping') try { ws.send('pong') } catch { /* gone */ } }
  webSocketClose(ws: HubSocket) { this.drop(ws) }
  webSocketError(ws: HubSocket) { this.drop(ws) }
  private drop(ws: HubSocket) {
    const l = this.bySocket.get(ws)
    if (l) this.hub.remove(l)
    this.bySocket.delete(ws)
  }
}
