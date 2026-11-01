import assert from 'node:assert/strict'
import { Browser } from './browser.mjs'
const browser = await Browser.launch()
try {
  const page = await browser.newPage()
  await page.goto(process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188')
  const result = await page.eval(async () => {
    const Original = window.EventSource
    let source
    class FakeSource extends EventTarget {
      constructor() { super(); source = this }
      close() {}
    }
    window.EventSource = FakeSource
    try {
      const { subscribeRoomEvents } = await import('/src/features/room/room-events.ts')
      let created = 0, deleted = 0, resync = 0
      const stream = subscribeRoomEvents('room', '0', {
        onItemCreated: () => created++, onItemDeleted: () => deleted++, onResyncRequired: () => resync++,
        onMembersChanged() {}, onRoomUpdated() {}, onRoomClosed() {}, onConnectionChange() {},
      })
      const emit = (type, eventId, data) => source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ type, eventId, roomId: 'room', data }) }))
      const item = { id: 'item', roomId: 'room', senderMemberId: 'member', createdAt: new Date().toISOString(), kind: 'text', text: 'hello', asset: null }
      emit('item.created', '1', item)
      emit('item.created', '1', item)
      emit('item.deleted', '2', { id: 42 })
      emit('item.created', '3', { ...item, id: 'late' })
      stream.close()
      return { created, deleted, resync }
    } finally { window.EventSource = Original }
  })
  assert.deepEqual(result, { created: 1, deleted: 0, resync: 1 })
  console.log('PASS duplicate event ignored, malformed deletion triggers one resync, closed stream ignores late data')
} finally { await browser.close() }
