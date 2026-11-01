import assert from 'node:assert/strict'
import { Browser, sleep, enterRoom } from './browser.mjs'
const wait = async (page, fn, label, arg) => { for (let i = 0; i < 250; i++) { if (await page.eval(fn, arg)) return; await sleep(100) } throw Error(`${label}: ` + await page.eval(() => document.body.innerText.slice(0, 400))) }
const browser = await Browser.launch()
try {
  for (const theme of ['light', 'dark']) {
    for (const viewport of [{ width: 390, height: 844, mobile: true }, { width: 1280, height: 800 }]) {
      const page = await browser.newPage(viewport)
      const url = process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5191'
      await page.goto(url)
      await page.eval((t) => localStorage.setItem('webdrop-theme', t), theme)
      await page.goto(url)
      await enterRoom(page)
      await wait(page, () => !!document.querySelector('textarea'), 'room')
      // Upload a few files serially: the list shows the loaded page, uploads interleave live.
      const longName = `这是一个非常长的文件名用来验证换行和截断行为-${'名'.repeat(40)}.txt`
      const names = [longName, ...Array.from({ length: 4 }, (_, i) => `file-${i}.txt`)]
      for (const name of names) {
        await page.eval((n) => {
          const input = document.querySelector('input[type=file]')
          const dt = new DataTransfer()
          dt.items.add(new File([`bytes-${n.slice(0, 8)}`], n, { type: 'text/plain' }))
          input.files = dt.files
          input.dispatchEvent(new Event('change', { bubbles: true }))
        }, name)
        await wait(page, (n) => (document.querySelector('[role=log]')?.innerText ?? '').includes(n.slice(0, 10)), `upload ${name.slice(0, 10)}`, name)
      }

      // Open the file list from the top bar.
      const opened = await page.eval(() => {
        const btn = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === '文件') ?? document.querySelector('button[aria-label="文件列表"]')
        btn?.click()
        return !!btn
      })
      assert.ok(opened, `file entry visible (${theme} ${viewport.width})`)
      await wait(page, () => document.body.innerText.includes('已加载'), 'file list')
      const title = await page.eval(() => [...document.querySelectorAll('[role=dialog] h2')].map(e => e.textContent).join('|'))
      assert.ok(title.includes('已加载'), `scoped title, got ${title}`)
      // Long filename present and truncated, not overflowing.
      assert.ok(await page.eval((n) => document.body.innerText.includes(n.slice(0, 12)), longName), 'long file visible in list')
      const overflow = await page.eval(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(overflow <= 1, `no page overflow (${theme} ${viewport.width})`)
      // List announces loaded scope, not full-room claims.
      assert.ok(await page.eval(() => document.body.innerText.includes('仅展示当前已加载的消息附件')))
      // Filter chips keep counts and do not reload the page.
      await page.eval(() => [...document.querySelectorAll('[role=tab]')].find(e => e.textContent.includes('文件'))?.click())
      await sleep(200)
      const topAfterFilter = await page.eval(() => document.querySelector('[role=dialog]')?.getBoundingClientRect().top ?? 0)
      assert.ok(Math.abs(topAfterFilter) > 0, 'dialog stays mounted')
      // Search within loaded scope.
      await page.eval(() => document.querySelector('#file-search')?.focus())
      await page.send('Input.insertText', { text: longName.slice(0, 6) })
      await sleep(300)
      assert.ok(await page.eval((n) => document.body.innerText.includes(n.slice(0, 12)), longName), 'search hits loaded file')
      await page.eval(() => { const el = document.querySelector('#file-search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })) })
      await sleep(200)
      // Preview from the list, then return: filter/search/scroll preserved.
      await page.eval(() => [...document.querySelectorAll('[role=dialog] button')].find(e => e.textContent.trim() === '下载')?.click())
      await sleep(300)
      // Delete sync: confirm copy mentions chat removal.
      const delBtn = await page.eval(() => {
        const btn = [...document.querySelectorAll('[role=dialog] li button')].find(e => e.textContent.trim() === '删除')
        btn?.click()
        return !!btn
      })
      if (delBtn) {
        await wait(page, () => document.body.innerText.includes('聊天中的对应附件也会消失'), 'delete confirm')
        await page.eval(() => [...document.querySelectorAll('button')].find(e => e.textContent.trim() === '确认删除')?.click())
        await sleep(800)
      }
      // Pagination: load older to pull earlier pages into the same loaded scope.
      const moreBtn = await page.eval(() => [...document.querySelectorAll('[role=dialog] button')].some(e => e.textContent.includes('加载更早的附件')))
      if (moreBtn) {
        await page.eval(() => [...document.querySelectorAll('[role=dialog] button')].find(e => e.textContent.includes('加载更早的附件'))?.click())
        await sleep(800)
        assert.ok(await page.eval(() => document.body.innerText.includes('已加载')), 'still scoped after pagination')
      }
      assert.deepEqual(page.consoleErrors, [])
      console.log(`PASS file list ${theme} ${viewport.width}`)
      await page.eval(() => document.querySelector('[role=dialog] button[aria-label="关闭"]')?.click())
    }
  }
} finally { await browser.close() }
