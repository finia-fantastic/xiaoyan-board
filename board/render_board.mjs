// 把 boardNN.html 渲染成 3508×4961 的 PNG（A3 300dpi 画布）。
// render_board.py 的等价脚本，给没装 Python 3.8+ 的机器用：
//   npm i playwright-core
//   node render_board.mjs board05_zhanban.html out.png
import { chromium } from 'playwright-core'
import path from 'node:path'

const [, , htmlArg = 'board05_zhanban.html', outArg = 'out.png'] = process.argv
const W = 3508
const H = 4961

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  })
  await page.goto('file:///' + path.resolve(htmlArg).replace(/\\/g, '/'), {
    waitUntil: 'networkidle',
  })
  await page.waitForTimeout(1500)

  const contentHeight = await page.evaluate(() => {
    const el = document.getElementById('inner')
    const kids = [...el.children].map(c => c.getBoundingClientRect().bottom)
    const box = el.getBoundingClientRect()
    return Math.ceil(Math.max(box.bottom, ...kids) - box.top)
  })

  const scale = Math.min(1, H / Math.max(1, contentHeight))
  await page.evaluate(s => {
    document.getElementById('inner').style.transform = `scale(${s})`
  }, scale)
  await page.waitForTimeout(800)
  await page.screenshot({ path: outArg, fullPage: false })

  console.log(`content ${contentHeight}px -> scale ${scale.toFixed(4)} -> ${outArg}`)
} finally {
  await browser.close()
}
