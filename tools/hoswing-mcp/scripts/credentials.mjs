// 账号密码的本地加密存储（Windows DPAPI，绑定当前 Windows 用户）。
// 只保存密文；解密只发生在内存里，不打印、不落盘、不进日志。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const SECRET_DIR = join(ROOT, '.secrets')
export const SECRET_FILE = join(SECRET_DIR, 'login.json')

function ps(script, input) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { input, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`DPAPI 调用失败: ${(result.stderr || '').trim().slice(0, 300)}`)
  return result.stdout.trim()
}

const PROTECT = `Add-Type -AssemblyName System.Security
$raw = [Console]::In.ReadToEnd().Trim()
$bytes = [Text.Encoding]::UTF8.GetBytes($raw)
$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[Convert]::ToBase64String($enc)`

const UNPROTECT = `Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd().Trim()
$enc = [Convert]::FromBase64String($b64)
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser')
[Text.Encoding]::UTF8.GetString($bytes)`

export function protect(plain) {
  if (!plain) throw new Error('密码为空')
  return ps(PROTECT, plain)
}

export function unprotect(cipher) {
  if (!cipher) throw new Error('没有保存密码')
  return ps(UNPROTECT, cipher)
}

/** 保存登录信息。密码只以 DPAPI 密文形式落盘。 */
export function saveLogin({ username, password, site = 'https://www.hoswing.cn/idmaster' }) {
  if (!username || !password) throw new Error('用户名和密码都必须提供')
  mkdirSync(SECRET_DIR, { recursive: true })
  const payload = { site, username, passwordCipher: protect(password), savedAt: new Date().toISOString() }
  writeFileSync(SECRET_FILE, JSON.stringify(payload, null, 2), 'utf8')
  return { file: SECRET_FILE, username }
}

export function hasLogin() {
  return existsSync(SECRET_FILE)
}

/** 读取登录信息。仅在调用方内存中使用，不要打印或写日志。 */
export function loadLogin() {
  if (!hasLogin()) throw new Error(`没有保存登录信息，请先运行：node scripts/save-login.mjs <账号> <密码>`)
  const data = JSON.parse(readFileSync(SECRET_FILE, 'utf8'))
  return { site: data.site, username: data.username, password: unprotect(data.passwordCipher) }
}
