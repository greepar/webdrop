import assert from 'node:assert/strict'
import { Browser } from './browser.mjs'
const browser = await Browser.launch()
try {
  const page = await browser.newPage({ width: 390, height: 844, mobile: true })
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await page.goto(process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188')
  const styles = await page.eval(() => {
    const spinner = document.createElement('span')
    spinner.className = 'anim-spin'
    document.body.append(spinner)
    const enter = document.querySelector('.anim-enter')
    const button = document.querySelector('button')
    return { spin: getComputedStyle(spinner).animationName, enter: getComputedStyle(enter).animationName, transition: getComputedStyle(button).transitionDuration }
  })
  assert.equal(styles.spin, 'none')
  assert.equal(styles.enter, 'wd-fade')
  assert.equal(styles.transition, '0s')
  console.log('PASS reduced motion: no spinner loop or control transition, entrance fades only')
} finally { await browser.close() }
