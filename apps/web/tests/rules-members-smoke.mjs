import assert from 'node:assert/strict'
import { Browser, sleep, enterRoom } from './browser.mjs'
const wait = async (page, fn, label) => { for (let i = 0; i < 150; i++) { if (await page.eval(fn)) return; await sleep(100) } throw Error(`${label}: ` + await page.eval(() => document.body.innerText.slice(0, 400))) }
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
      // Members: cards, no dividers.
      await page.eval(() => [...document.querySelectorAll('button')].find(e => e.textContent.trim().startsWith('成员'))?.click())
      await wait(page, () => !!document.querySelector('[role=dialog]'), 'members')
      const cardCount = await page.eval(() => document.querySelectorAll('[role=dialog] ul li.sketch').length)
      const dividers = await page.eval(() => document.querySelectorAll('[role=dialog] ul.divide-y').length)
      assert.ok(cardCount >= 1, `members render as cards (${theme} ${viewport.width})`)
      assert.equal(dividers, 0, 'no divider list remains')
      const overflow = await page.eval(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(overflow <= 1, `no horizontal overflow (${theme} ${viewport.width})`)
      await page.eval(() => document.querySelector('[aria-label="关闭"]')?.click())

      // Rules: stable copy, per-row status, no fixed heights.
      await page.eval(() => document.querySelector('[aria-label="房间设置"]')?.click() ?? [...document.querySelectorAll('button')].find(e => e.textContent.trim() === '管理')?.click())
      await wait(page, () => document.body.innerText.includes('入房规则'), 'rules')
      const before = await page.eval(() => {
        const rows = [...document.querySelectorAll('section[aria-label="入房规则"] p.text-sm + p')]
        const dlg = document.querySelector('[role=dialog] > div:last-child')
        return { texts: rows.map(e => e.textContent), top: document.querySelector('[role=dialog]').getBoundingClientRect().top, scroll: dlg ? dlg.scrollTop : 0 }
      })
      assert.deepEqual(before.texts, [
        '新成员加入时的门槛，密码和审批可以同时开启。已有成员不受影响。',
        '关闭后阻止新成员加入，已有成员不受影响。',
        '新成员加入时需验证密码，可与审批同时使用。',
        '新成员需经管理员批准后才能进入。',
      ])
      // Toggle policy: copy must not rewrite, dialog top must not jump.
      await page.eval(() => document.querySelector('[role=switch][aria-label="允许新成员加入"]')?.click())
      await wait(page, () => document.body.innerText.includes('保存中'), 'saving')
      const during = await page.eval(() => ({ top: document.querySelector('[role=dialog]').getBoundingClientRect().top }))
      assert.ok(Math.abs(during.top - before.top) < 2, `dialog top stable while saving (${theme} ${viewport.width})`)
      await wait(page, () => document.querySelector('[role=switch][aria-label="允许新成员加入"]')?.getAttribute('aria-checked') === 'false', 'locked')
      const after = await page.eval(() => {
        const rows = [...document.querySelectorAll('section[aria-label="入房规则"] p.text-sm + p')]
        const dlg = document.querySelector('[role=dialog]')
        const body = document.querySelector('[role=dialog] > div:last-child')
        return { texts: rows.map(e => e.textContent), top: dlg.getBoundingClientRect().top, height: dlg.getBoundingClientRect().height, scroll: body ? body.scrollTop : 0, scrollH: body ? body.scrollHeight : 0, clientH: body ? body.clientHeight : 0 }
      })
      assert.deepEqual(after.texts, before.texts, 'description copy stays stable across toggle')
      // Content grew taller than the 88dvh sheet: the sheet stays centered and the inner container
      // scrolls (scrollH > clientH). Top movement from centering is expected, not a jitter.
      assert.ok(after.scrollH > after.clientH, `overflow goes to inner scroll (${theme} ${viewport.width})`)
      assert.ok(Math.abs(after.top - before.top) < 40, `dialog recenters instead of jumping (${theme} ${viewport.width})`)
      // Rapid double tap: single request, no duplicate flip.
      await page.eval(() => { document.querySelector('[role=switch][aria-label="允许新成员加入"]')?.click(); document.querySelector('[role=switch][aria-label="允许新成员加入"]')?.click() })
      await wait(page, () => document.querySelector('[role=switch][aria-label="允许新成员加入"]')?.getAttribute('aria-checked') === 'true', 'reopen')
      // Password expand/collapse: no leftover blank space.
      await page.eval(() => document.querySelector('[role=switch][aria-label="房间密码"]')?.click())
      await wait(page, () => !!document.querySelector('#room-password'), 'password form')
      await page.eval(() => document.querySelector('[role=switch][aria-label="房间密码"]')?.click())
      await sleep(300)
      const collapsed = await page.eval(() => {
        const wrap = document.querySelector('#room-password')?.closest('.grid')
        return wrap ? getComputedStyle(wrap).gridTemplateRows : 'gone'
      })
      assert.ok(collapsed === 'gone' || collapsed === '0px', `password collapses without blank space, got ${collapsed}`)
      assert.deepEqual(page.consoleErrors, [])
      console.log(`PASS rules/member cards ${theme} ${viewport.width}`)
    }
  }
} finally { await browser.close() }
