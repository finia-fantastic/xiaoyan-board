import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HoswingBrowser } from './browser.mjs';
import { Pipeline } from './pipeline.mjs';
import { ROOT, DEFAULT_PROJECT, readJob, summary, id } from './core.mjs';

const api=new HoswingBrowser();const pipeline=new Pipeline(api);
const server=new McpServer({name:'hoswing-mcp',version:'0.1.0'},{instructions:'Use hoswing_status/open_login first. Read the live model catalog before creating jobs. Read the user storyboard and map reference files explicitly. create_job is local only. quote_job obtains server quotes. Before start_job the human must approve uploading those files and a maximum credit budget. Do not infer spending approval from a request to build/test this MCP. Submission uncertainty MUST resume the same job; never create a new job to retry. Jobs are serial; get_job reports progress. API adapter is derived from public website frontend and requires live verification after login.'});
const project=z.string().default(DEFAULT_PROJECT);
const readAnnotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true};
let queue=Promise.resolve();
function register(name,description,schema,annotations,fn){
  server.registerTool(name,{description,inputSchema:schema,annotations},async args=>{
    const action=async()=>{
      try{return {content:[{type:'text',text:JSON.stringify(await fn(args),null,2)}]};}
      catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}
    };
    const result=queue.then(action,action);queue=result.then(()=>undefined);return result;
  });
}
register('hoswing_status','检查本地浏览器连接与登录，不返回令牌。',{projectId:project},readAnnotations,a=>api.status(a.projectId));
register('hoswing_open_login','复用 Edge 的 Hoswing 标签页，或打开目标项目供用户登录。不要索取密码。',{projectId:project},{...readAnnotations,readOnlyHint:false},a=>api.openLogin(a.projectId));
register('hoswing_models','读取项目当前可用模型、参数与价格配置，禁止猜模型 ID。',{projectId:project},readAnnotations,async a=>{await api.selectPage(a.projectId);return pipeline.models(a.projectId);});
register('hoswing_project','只读项目及画布节点摘要。',{projectId:project},readAnnotations,async a=>{
  await api.selectPage(a.projectId);
  const p=await api.request(pipeline.route(a.projectId));
  const canvas=await api.request(pipeline.route(a.projectId,'/canvas'));
  return {project:p,revision:canvas.revision,nodes:canvas.nodes?.map(n=>({id:n.id,label:n.data?.label,kind:n.data?.kind,status:n.data?.status})),edgeCount:canvas.edges?.length};
});
register('hoswing_create_job','本地导入 CSV/XLSX/JSON 分镜，或传结构化 shots。字段：id,title,prompt,imagePrompt,durationSeconds,aspectRatio,references（本地路径数组）,firstFrame,lastFrame,referenceAssetVersionIds。不上传、不生成。',{projectId:project,storyboardPath:z.string().optional(),shots:z.array(z.record(z.string(),z.unknown())).optional(),assetDir:z.string().optional(),mode:z.enum(['image','video']).default('video'),provider:z.string().min(1),modelId:z.string().min(1),operation:z.enum(['image.generate','image.edit','video.generate']).optional(),parameters:z.record(z.string(),z.unknown()).default({}),outputDir:z.string().optional()},{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},a=>pipeline.create(a));
register('hoswing_quote_job','从网站获取逐镜报价；不上传本地素材，不提交生成。',{jobId:z.string()},readAnnotations,a=>pipeline.quote(a.jobId));
register('hoswing_start_job','用户明确批准素材上传和积分上限后启动/恢复后台串行任务。同一任务幂等恢复。',{jobId:z.string(),approveUploadAndGeneration:z.literal(true),maxCredits:z.number().nonnegative()},{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},async a=>{
  const state=await pipeline.prepareStart(a.jobId,a.maxCredits);
  const worker=fileURLToPath(new URL('./worker.mjs',import.meta.url));
  const logDir=path.join(ROOT,'logs');await fs.mkdir(logDir,{recursive:true});
  const handle=await fs.open(path.join(logDir,id(a.jobId)+'.log'),'a');
  try{
    const child=spawn(process.execPath,[worker,a.jobId],{cwd:path.dirname(worker),detached:true,windowsHide:true,stdio:['ignore',handle.fd,handle.fd],env:process.env});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
    return {...state,pid:child.pid,note:'使用 hoswing_get_job 查询。任务只串行提交；网络中断后恢复同一 jobId。'};
  }finally{await handle.close();}
});
register('hoswing_get_job','读取本地任务进度、错误、生成任务号及下载结果。',{jobId:z.string()},{...readAnnotations,openWorldHint:false},async a=>summary(await readJob(a.jobId)));
register('hoswing_stop_job','停止后续镜头，工作进程请求取消当前生成任务。积分退还由网站决定。',{jobId:z.string()},{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true},a=>pipeline.stop(a.jobId));
register('hoswing_download_completed','下载任务已确认成功的素材，不重新生成。',{jobId:z.string()},{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true},a=>pipeline.downloadCompleted(a.jobId));
register('hoswing_screenshot','保存当前 Hoswing 标签页截图到本地诊断目录。',{},readAnnotations,()=>api.screenshot());
await server.connect(new StdioServerTransport());
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await api.disconnect();process.exit(0);});
