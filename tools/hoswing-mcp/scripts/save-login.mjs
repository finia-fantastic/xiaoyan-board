// 一次性保存 Hoswing 账号密码（DPAPI 加密，绑定当前 Windows 用户）。
// 用法：node scripts/save-login.mjs <账号> <密码>
// 也可以只传账号，密码从标准输入读（避免进命令行历史）。
import { createInterface } from 'node:readline/promises'
import { saveLogin } from './credentials.mjs'

const [username, inlinePassword] = process.argv.slice(2)
if (!username) {
  console.error('用法：node scripts/save-login.mjs <账号> [密码]')
  process.exit(1)
}
let password = inlinePassword
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  password = await rl.question('密码（不回显，输入后回车）：')
  rl.close()
}
const saved = saveLogin({ username, password })
console.log(`已加密保存：${saved.username} → ${saved.file}`)
console.log('密码是 DPAPI 密文，只有当前 Windows 用户能解开。')
