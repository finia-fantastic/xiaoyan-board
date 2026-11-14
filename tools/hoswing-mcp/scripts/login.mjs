// 用本地加密保存的账号密码登录 Hoswing。
// 前提：Edge 已带 --remote-debugging-port=9333 运行（或先跑 scripts/open-browser.mjs）。
// 令牌保存在那个标签页的 sessionStorage，所以脚本复用已有标签页，不另开。
//
// 用法：node scripts/login.mjs [projectId]
import { chromium } from 'playwright-core'
import { loadLogin } from './credentials.mjs'

const CDP = process.env.HOSWING_CDP_URL || 'http://127.0.0.1:9333'
const PROJECT = process.argv[2] || process.env.HOSWING_PROJECT_ID || ''
if (!PROJECT) { console.error('请传 projectId 或设置 HOSWING_PROJECT_ID'); process.exit(1) }
const BASE = 'https://www.hoswing.cn/idmaster'

const tokenPresent = page => page.evaluate(() => Boolean(sessionStorage.getItem('mangahermes.accessToken')))

const browser = await chromium.connectOverCDP(CDP)
const pages = browser.contexts().flatMap(c => c.pages())
let page = pages.find(p => (p.url() || '').includes('hoswing.cn'))
if (!page) {
  page = await browser.contexts()[0].newPage()
  await page.goto(`${BASE}/canvas?projectId=${PROJECT}`, { waitUntil: 'domcontentloaded' })
}

if (await tokenPresent(page)) {
  console.log(JSON.stringify({ ok: true, alreadyLoggedIn: true, url: page.url() }))
  await browser.close()
  process.exit(0)
}

const { username, password } = loadLogin()

await page.goto(`${BASE}?auth=login&next=${encodeURIComponent(`/canvas?projectId=${PROJECT}`)}`, { waitUntil: 'domcontentloaded' })
const userBox = page.locator('input[autocomplete="username"]')
await userBox.waitFor({ state: 'visible', timeout: 30000 })
await userBox.fill(username)
await page.locator('input[type="password"]').fill(password)
await page.locator('button:has-text("进入创作空间")').click()

try {
  await page.waitForFunction(() => Boolean(sessionStorage.getItem('mangahermes.accessToken')), null, { timeout: 30000 })
} catch {
  const notice = await page.locator('body').innerText().catch(() => '')
  console.log(JSON.stringify({ ok: false, error: '登录后没有拿到令牌（可能需要验证码或密码有误）', url: page.url(), pageText: notice.slice(0, 300) }))
  await browser.close()
  process.exit(2)
}

console.log(JSON.stringify({ ok: true, alreadyLoggedIn: false, url: page.url() }))
await browser.close()
