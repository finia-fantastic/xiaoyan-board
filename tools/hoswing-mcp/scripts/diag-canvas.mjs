import { readFileSync } from 'node:fs'
import { HoswingBrowser } from '../src/browser.mjs'

const jobPath = process.argv[2]
const job = JSON.parse(readFileSync(jobPath, 'utf8'))
const shot = job.shots.find(s => s.node)
const api = new HoswingBrowser()
const canvas = await api.request(`/api/v1/projects/${job.projectId}/canvas`)
const saved = canvas.nodes?.find(n => n.id === shot.node.id)
console.log('job status:', job.status, '| error:', job.error)
console.log('node id:', shot.node.id, '| 画布上找得到:', Boolean(saved))
console.log('画布 revision:', canvas.revision, '| 节点总数:', canvas.nodes?.length)
if (saved) {
  const fields = ['prompt', 'modelId', 'modelProvider', 'modelOperation', 'modelParameters', 'referenceAssetVersionIds']
  for (const f of fields) {
    const a = JSON.stringify(shot.node.data?.[f])
    const b = JSON.stringify(saved.data?.[f])
    console.log(a === b ? `  ✅ ${f}` : `  ❌ ${f}\n     写入: ${a?.slice(0, 300)}\n     读回: ${b?.slice(0, 300)}`)
  }
  const keysNew = Object.keys(shot.node.data || {}), keysSaved = Object.keys(saved.data || {})
  console.log('  写入字段:', keysNew.join(','))
  console.log('  读回字段:', keysSaved.join(','))
} 
await api.browser?.close()
