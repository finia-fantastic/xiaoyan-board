import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

export const ROOT = path.resolve(process.env.HOSWING_DATA_DIR || new URL('../data', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
// 项目 ID 属于个人数据，不进仓库：用 HOSWING_PROJECT_ID 环境变量或调用时显式传 projectId。
export const DEFAULT_PROJECT = process.env.HOSWING_PROJECT_ID || '';
export const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'expired', 'insufficient-credit', 'permission-denied', 'offline']);
export function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) throw Error('INVALID_ID');
  return value;
}
export function safeName(value) {
  let s = String(value).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0,90);
  if (!s || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) s = 'asset_' + s;
  return s;
}
export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive:true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', {flag:'wx'});
  await fs.rename(tmp, file);
}
export const jobPath = jobId => {
  if(typeof jobId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(jobId))throw Error('INVALID_JOB_ID');
  return path.join(ROOT, 'jobs', jobId + '.json');
};
export async function readJob(jobId) { return JSON.parse(await fs.readFile(jobPath(jobId), 'utf8')); }
export async function saveJob(job) { job.updatedAt = new Date().toISOString(); await writeJson(jobPath(job.id), job); }
export async function lockJob(jobId, fn) {
  const file = jobPath(jobId) + '.lock';
  await fs.mkdir(path.dirname(file), {recursive:true});
  let handle;
  try { handle = await fs.open(file, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') throw Error('JOB_LOCKED: 此任务已有工作进程；异常退出留下的锁须确认进程已停止后移除。'); throw e; }
  try { await handle.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()})); return await fn(); }
  finally { await handle.close(); await fs.unlink(file); }
}
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

const ALIASES = {
  id:['id','shot_id','镜头编号','镜号','编号'],
  title:['title','name','标题','镜头名称'],
  prompt:['prompt','video_prompt','提示词','视频提示词','画面描述','画面内容','分镜描述'],
  imagePrompt:['imagePrompt','image_prompt','图片提示词','首帧提示词'],
  durationSeconds:['durationSeconds','duration','时长','时长秒','时长（秒）'],
  aspectRatio:['aspectRatio','ratio','比例','画幅比例'],
  references:['references','素材','参考素材','参考图','素材路径'],
  firstFrame:['firstFrame','first_frame','首帧'],
  lastFrame:['lastFrame','last_frame','尾帧'],
  referenceAssetVersionIds:['referenceAssetVersionIds','素材版本ID']
};
const pick = (row, key) => ALIASES[key].map(k=>row[k]).find(v=>v !== undefined && v !== null && v !== '');
const list = value => Array.isArray(value) ? value : value ? String(value).split(/[;；\n|]/).map(x=>x.trim()).filter(Boolean) : [];
export function normalizeRows(rows, {baseDir=process.cwd(), mode='video'}={}) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 200) throw Error('STORYBOARD_REQUIRES_1_TO_200_ROWS');
  const seen = new Set();
  return rows.map((row, index)=>{
    if (!row || typeof row !== 'object') throw Error(`INVALID_ROW_${index+1}`);
    const shotId = String(pick(row,'id') ?? index+1);
    if (seen.has(shotId)) throw Error(`DUPLICATE_SHOT_ID: ${shotId}`);
    seen.add(shotId);
    const prompt = String((mode === 'image' ? pick(row,'imagePrompt') : undefined) ?? pick(row,'prompt') ?? '').trim();
    if (!prompt || prompt.length > 20000) throw Error(`PROMPT_MISSING_OR_TOO_LONG: ${shotId}`);
    const duration = pick(row,'durationSeconds');
    const seconds = duration === undefined ? 5 : Number(String(duration).replace(/\s*(s|秒)$/, ''));
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) throw Error(`INVALID_DURATION: ${shotId}`);
    const resolveFile = p => path.resolve(baseDir, String(p));
    return {
      id:shotId, title:String(pick(row,'title') ?? `镜头 ${shotId}`).slice(0,80), prompt,
      durationSeconds:seconds, aspectRatio:String(pick(row,'aspectRatio') ?? '16:9'),
      references:list(pick(row,'references')).map(resolveFile),
      referenceAssetVersionIds:list(pick(row,'referenceAssetVersionIds')).map(id),
      firstFrame:pick(row,'firstFrame') ? resolveFile(pick(row,'firstFrame')) : undefined,
      lastFrame:pick(row,'lastFrame') ? resolveFile(pick(row,'lastFrame')) : undefined
    };
  });
}
export async function loadStoryboard(file, mode) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 20*1024*1024) throw Error('STORYBOARD_FILE_INVALID_OR_OVER_20MB');
  const ext = path.extname(file).toLowerCase(); let rows;
  if (ext === '.xlsx') {
    const book = new ExcelJS.Workbook(); await book.xlsx.readFile(file);
    const sheet = book.worksheets[0]; if (!sheet) throw Error('EMPTY_WORKBOOK');
    const value = c => c.value?.result ?? (c.value?.richText ? c.value.richText.map(t=>t.text).join('') : c.value);
    const headers = sheet.getRow(1).values.slice(1).map(v=>String(v ?? '').trim()); rows=[];
    sheet.eachRow((row,i)=>{if(i>1) rows.push(Object.fromEntries(headers.map((h,k)=>[h,value(row.getCell(k+1))])));});
  } else {
    const text = (await fs.readFile(file,'utf8')).replace(/^﻿/,'');
    if(ext === '.json') { const parsed=JSON.parse(text); rows=Array.isArray(parsed)?parsed:parsed.shots; }
    else if(ext === '.csv') rows=parse(text,{columns:true,skip_empty_lines:true,trim:true,bom:true});
    else throw Error('SUPPORTED_STORYBOARD_FORMATS: .json .csv .xlsx');
  }
  return normalizeRows(rows,{baseDir:path.dirname(path.resolve(file)),mode});
}
export function mediaInfo(file) {
  const ext=path.extname(file).toLowerCase();
  const map={'.png':['IMAGE','image/png'],'.jpg':['IMAGE','image/jpeg'],'.jpeg':['IMAGE','image/jpeg'],'.webp':['IMAGE','image/webp'],'.mp4':['VIDEO','video/mp4'],'.mov':['VIDEO','video/quicktime'],'.webm':['VIDEO','video/webm'],'.mp3':['AUDIO','audio/mpeg'],'.wav':['AUDIO','audio/wav'],'.m4a':['AUDIO','audio/mp4'],'.txt':['DOCUMENT','text/plain'],'.pdf':['DOCUMENT','application/pdf'],'.docx':['DOCUMENT','application/vnd.openxmlformats-officedocument.wordprocessingml.document']};
  if(!map[ext]) throw Error(`UNSUPPORTED_ASSET_EXTENSION: ${ext}`);
  return {kind:map[ext][0],mimeType:map[ext][1]};
}
export function buildNode(job, shot, index, assets) {
  const references = [...new Set([...shot.referenceAssetVersionIds,...shot.references.map(p=>assets[p].assetVersionId),...[shot.firstFrame,shot.lastFrame].filter(Boolean).map(p=>assets[p].assetVersionId)])];
  const mediaKinds = Object.fromEntries(Object.values(assets).map(a=>[a.assetVersionId,a.kind.toLowerCase()]));
  // 网站把参考视频放在独立字段：videoReferenceAssetVersionIds。
  // 混进 referenceAssetVersionIds 会被上游当成非法输入（实测 5s 测试任务受理失败）。
  const videoReferences = references.filter(id=>mediaKinds[id]==='video');
  const imageReferences = references.filter(id=>mediaKinds[id]!=='video');
  const parameters = {...job.parameters,aspectRatio:shot.aspectRatio,...job.mode==='video'?{durationSeconds:shot.durationSeconds}:{count:1}};
  return {
    id:`mcp-${job.id.slice(-12)}-${String(index+1).padStart(3,'0')}`,type:'studio',version:1,
    position:{x:job.origin.x,y:job.origin.y+index*340},
    data:{kind:job.mode==='image'?'prompt-image':'prompt-video',label:shot.title,description:shot.title,
      prompt:shot.prompt,status:'ready',version:1,projectId:job.projectId,locked:false,
      modelProvider:job.provider,modelId:job.modelId,modelOperation:job.operation,modelParameters:parameters,
      referenceAssetVersionIds:imageReferences,referenceMediaKinds:mediaKinds,
      ...(videoReferences.length?{videoReferenceAssetVersionIds:videoReferences}:{}),
      ...(shot.firstFrame?{firstFrameAssetVersionId:assets[shot.firstFrame].assetVersionId}:{}),
      ...(shot.lastFrame?{lastFrameAssetVersionId:assets[shot.lastFrame].assetVersionId}:{}),
      ...(job.mode==='image'?{imageGenerationMode:references.length?'image-to-image':'text-to-image'}:{})}
  };
}
export function quoteBody(job, shot) {
  const count=shot.referenceAssetVersionIds.length+shot.references.length+Number(!!shot.firstFrame)+Number(!!shot.lastFrame);
  return {operation:job.operation,provider:job.provider,modelId:job.modelId,
    parameters:{...job.parameters,aspectRatio:shot.aspectRatio,...job.mode==='video'?{durationSeconds:shot.durationSeconds}:{count:1}},
    input:{promptLength:shot.prompt.length,outputCount:1,...job.mode==='video'?{durationSeconds:shot.durationSeconds}:{},assetCount:Math.max(1,count),referenceVideoCount:shot.references.filter(p=>mediaInfo(p).kind==='VIDEO').length}};
}
export function quoteCredits(result) {
  if(typeof result?.quotedCredits !== 'number' || !Number.isFinite(result.quotedCredits) || result.quotedCredits<0) throw Error('INVALID_SERVER_QUOTE');
  return result.quotedCredits;
}
export function reserve(job, amount) {
  if(!Number.isFinite(job.approvedMaxCredits)||job.approvedMaxCredits<0) throw Error('BUDGET_NOT_APPROVED');
  if(job.reservedCredits+amount>job.approvedMaxCredits) throw Error('APPROVED_CREDIT_BUDGET_EXCEEDED');
  job.reservedCredits+=amount;
}
export function summary(job) {
  return {id:job.id,status:job.status,projectId:job.projectId,mode:job.mode,provider:job.provider,modelId:job.modelId,
    quoteTotal:job.quoteTotal,approvedMaxCredits:job.approvedMaxCredits,reservedCredits:job.reservedCredits,
    error:job.error,updatedAt:job.updatedAt,outputDir:job.outputDir,
    shots:job.shots.map(s=>({id:s.id,title:s.title,status:s.status,jobId:s.jobId,error:s.error,assetVersionIds:s.assetVersionIds,files:s.files}))};
}
