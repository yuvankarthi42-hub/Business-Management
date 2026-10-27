import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { PER_SHOP } from './helpers'
import { feedDecision } from '../../src/data/remote/feedTiming'

type Feed = { latest: number; epoch?: string | null; own?: number | null }

test('every signed-in answer carries the change number; own writes say which change is theirs', async () => {
  const s = await withShop()
  try {
    const raw = async (name: string, ...args: unknown[]) => {
      const res = await fetch(`${s.base}/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.ownerToken}` }, body: JSON.stringify({ args }) })
      return await res.json() as { data?: unknown; feed?: Feed; error?: unknown }
    }
    const read = await raw('products.list')
    if (!PER_SHOP) { assert.equal(read.feed, undefined, 'single-database mode: unchanged'); return }
    assert.equal(typeof read.feed?.latest, 'number')
    assert.ok(read.feed?.epoch)
    assert.equal(read.feed?.own ?? null, null, 'a read makes no change')

    const write = await raw('products.save', { name: 'Tea', price: 20 })
    assert.equal(write.error, undefined)
    assert.ok(write.feed && write.feed.latest > read.feed!.latest)
    assert.equal(write.feed.own, write.feed.latest, 'the newest change is this write')

    // The change feed itself and public pages get no note.
    assert.equal((await raw('sync.changes', null)).feed, undefined)
    const pub = await (await fetch(`${s.base}/rpc/public.track`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args: [s.businessId, '1'] }) })).json() as { feed?: unknown }
    assert.equal(pub.feed, undefined)

    // A browser that only saw its own write skips its timed check; another device's write makes it ask.
    const own = new Set([write.feed.own!])
    assert.equal(feedDecision(read.feed!.latest, write.feed, own, write.feed.epoch ?? null), 'own')
    await s.call('products.save', { name: 'Coffee', price: 25 }) // "another device"
    const after = await raw('products.list')
    assert.equal(feedDecision(write.feed.latest, after.feed!, own, write.feed.epoch ?? null), 'ask')
  } finally { s.close() }
})

test('feed decision: nothing new / only own / another device / account changed', () => {
  const none = new Set<number>()
  assert.equal(feedDecision(10, { latest: 10, epoch: 'e1' }, none, 'e1'), 'same')
  assert.equal(feedDecision(10, { latest: 9, epoch: 'e1' }, none, 'e1'), 'same')
  assert.equal(feedDecision(10, { latest: 12, epoch: 'e1' }, new Set([11, 12]), 'e1'), 'own')
  assert.equal(feedDecision(10, { latest: 12, epoch: 'e1' }, new Set([12]), 'e1'), 'ask', 'change 11 came from elsewhere')
  assert.equal(feedDecision(10, { latest: 10, epoch: 'e2' }, none, 'e1'), 'ask', 'settings / users / plan changed')
  assert.equal(feedDecision(10, { latest: 10 }, none, 'e1'), 'same', 'older server without epoch')
  assert.equal(feedDecision(0, { latest: 500 }, new Set(Array.from({ length: 500 }, (_, i) => i + 1)), null), 'ask', 'big gap: just ask')
})
