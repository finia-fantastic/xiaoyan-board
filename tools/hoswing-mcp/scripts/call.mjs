// 调用本项目的 MCP 工具：node scripts/call.mjs <工具名> ['{"json":参数}']
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const [tool, rawArgs] = process.argv.slice(2)
if (!tool) { console.error('用法：node scripts/call.mjs <工具名> [JSON参数]'); process.exit(1) }
const args = rawArgs
  ? JSON.parse(rawArgs.startsWith('@') ? (await import('node:fs')).readFileSync(rawArgs.slice(1), 'utf8') : rawArgs)
  : {}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(dirname(dirname(fileURLToPath(import.meta.url))), 'src/server.mjs')],
  env: { ...process.env, HOSWING_CDP_URL: process.env.HOSWING_CDP_URL || 'http://127.0.0.1:9333' },
})
const client = new Client({ name: 'hoswing-cli', version: '0.1.0' }, { capabilities: {} })
await client.connect(transport)
const result = await client.callTool({ name: tool, arguments: args })
const text = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')
console.log(text || JSON.stringify(result, null, 2))
await client.close()
