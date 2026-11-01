import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'
const browser = await Browser.launch()
try {
 const page = await browser.newPage()
 await page.goto(process.env.WEBDROP_TEST_URL)
 for (const theme of ['light', 'dark']) {
   await page.eval(theme => document.querySelector(`input[value=${theme}]`).click(), theme)
   await sleep(50)
   const pairs = await page.eval(() => {
     const style = getComputedStyle(document.documentElement)
     const luminance = token => {
       const hex = style.getPropertyValue(`--c-${token}`).trim().slice(1)
       const rgb = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
       return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
     }
     return [['ink', 'canvas'], ['muted', 'canvas'], ['ink', 'raised'], ['muted', 'raised'], ['accent-ink', 'accent']].map(([text, bg]) => {
       const a = luminance(text), b = luminance(bg)
       return { text, bg, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
     })
   })
   for (const pair of pairs) assert.ok(pair.ratio >= 4.5, `${theme} ${JSON.stringify(pair)}`)
   console.log(theme, pairs.map(p => `${p.text}/${p.bg}=${p.ratio.toFixed(2)}`).join(' '))
 }
 console.log('PASS primary semantic text token pairs meet 4.5:1 in both themes')
} finally { await browser.close() }
