import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { id, ROOT, mediaInfo, safeName } from './core.mjs';

export const BASE='https://www.hoswing.cn/idmaster';
export class ApiError extends Error {
  constructor(status,payload){super(`${payload?.code || 'HTTP_'+status}${payload?.message?': '+payload.message:''}`);this.status=status;this.payload=payload;}
}
export class HoswingBrowser {
  constructor(){this.browser=null;this.page=null;this.endpoint=process.env.HOSWING_CDP_URL||'http://127.0.0.1:9333';}
  async connect(){
    if(this.browser?.isConnected())return;
    const url=new URL(this.endpoint);
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('CDP_MUST_BE_LOCALHOST');
    try{this.browser=await chromium.connectOverCDP(this.endpoint,{timeout:5000});}
    catch{throw Error('BROWSER_NOT_CONNECTED: 请先运行项目的打开浏览器脚本，或启动带 9333 调试端口的 Edge。不会强制关闭现有浏览器。');}
    this.browser.on('disconnected',()=>{this.browser=null;this.page=null;});
  }
  async selectPage(projectId,create=false){
    await this.connect();
    if(!projectId && this.page && !this.page.isClosed()) {
      const current=new URL(this.page.url());
      if(current.origin==='https://www.hoswing.cn'&&current.pathname.startsWith('/idmaster')) return this.page;
      throw Error('PINNED_TAB_NAVIGATED_AWAY');
    }
    const pages=this.browser.contexts().flatMap(c=>c.pages()).filter(p=>{
      try{const u=new URL(p.url());return u.origin==='https://www.hoswing.cn'&&u.pathname.startsWith('/idmaster');}catch{return false;}
    });
    const preferred=pages.sort((a,b)=>Number(b.url().includes(projectId||'!'))-Number(a.url().includes(projectId||'!')));
    for(const p of preferred){if(await p.evaluate(()=>!!sessionStorage.getItem('mangahermes.accessToken')).catch(()=>false)){this.page=p;return p;}}
    if(preferred.length){this.page=preferred[0];return this.page;}
    if(!create)throw Error('HOSWING_TAB_NOT_FOUND: 先调用 hoswing_open_login，在打开的标签页登录。');
    const context=this.browser.contexts()[0];if(!context)throw Error('BROWSER_CONTEXT_MISSING');
    this.page=await context.newPage();
    await this.page.goto(`${BASE}/canvas?projectId=${encodeURIComponent(id(projectId))}`,{waitUntil:'domcontentloaded',timeout:30000});
    return this.page;
  }
  async openLogin(projectId){
    const p=await this.selectPage(projectId,true);await p.bringToFront();
    const state=await this.status(projectId);
    return {...state,instruction:state.authenticated?'登录已验证。':'请在这一个标签页内登录；令牌只保存在标签页中，勿关闭它。无需把密码发给 AI。'};
  }
  async status(projectId){
    try{
      const p=await this.selectPage(projectId);
      const hasSession=await p.evaluate(()=>!!sessionStorage.getItem('mangahermes.accessToken'));
      if(!hasSession)return {connected:true,authenticated:false,url:p.url()};
      const me=await this.request('/api/v1/auth/me');
      return {connected:true,authenticated:!!me.id,url:p.url(),accountId:me.id};
    }catch(e){return {connected:!!this.browser?.isConnected(),authenticated:false,error:e.message};}
  }
  async request(route,{method='GET',body,key,upload,timeout=30000}={}){
    if(!/^\/api\/v1\//.test(route)||route.includes('..'))throw Error('INVALID_API_ROUTE');
    const page=await this.selectPage();
    const result=await page.evaluate(async ({route,method,body,key,upload,timeout})=>{
      const base=location.origin+'/idmaster';
      // Use the site's own refresh function so rotating refresh tokens remain coordinated with the UI.
      async function refresh(){
        if(!self.webpackChunk_N_E)throw Error('SITE_SESSION_REFRESH_UNAVAILABLE');
        let req;
        const marker='hoswing-mcp-'+crypto.randomUUID();
        self.webpackChunk_N_E.push([[marker],{},r=>{req=r;}]);
        if(!req)throw Error('SITE_SESSION_REFRESH_UNAVAILABLE');
        await req(94586).x(base);
      }
      async function send(){
        const token=sessionStorage.getItem('mangahermes.accessToken');
        if(!token) return {status:401,payload:{code:'LOGIN_REQUIRED'}};
        const headers={authorization:'Bearer '+token};if(key)headers['idempotency-key']=key;
        let payload;
        if(upload){
          const bytes=Uint8Array.from(atob(upload.base64),c=>c.charCodeAt(0));
          payload=new FormData();payload.append('file',new Blob([bytes],{type:upload.mimeType}),upload.name);
          if(upload.sha256)headers['x-chunk-sha256']=upload.sha256;
        } else if(body!==undefined){headers['content-type']='application/json';payload=JSON.stringify(body);}
        const r=await fetch(base+route,{method,headers,body:payload,signal:AbortSignal.timeout(timeout),redirect:'error'});
        const text=await r.text();let data;
        try{data=text?JSON.parse(text):{};}catch{data={code:'NON_JSON_RESPONSE'};}
        return {status:r.status,payload:data};
      }
      let response=await send();
      if(response.status===401&&sessionStorage.getItem('mangahermes.refreshToken')){await refresh();response=await send();}
      return response;
    },{route,method,body,key,upload,timeout});
    if(result.status<200||result.status>=300)throw new ApiError(result.status,result.payload);
    return result.payload;
  }
  async upload(file,projectId,record,persist){
    const stat=await fs.stat(file);if(!stat.isFile()||stat.size<=0)throw Error('ASSET_FILE_EMPTY_OR_INVALID');
    const info=mediaInfo(file);
    if(record.assetVersionId)return record;
    if(record.size!==stat.size||record.mtime!==stat.mtimeMs)throw Error('ASSET_CHANGED_SINCE_JOB_CREATED: '+file);
    if(!record.key){Object.assign(record,{key:'mcp-upload-'+randomUUID(),kind:info.kind});await persist();}
    let session=record.sessionId?await this.request(`/api/v1/asset-uploads/${id(record.sessionId)}`):null;
    if(!session){
      session=await this.request('/api/v1/asset-uploads',{method:'POST',key:record.key,body:{projectId,kind:info.kind,name:path.basename(file),originalFilename:path.basename(file),mimeType:info.mimeType,totalBytes:stat.size,chunkSize:4194304,tags:['canvas','mcp'],metadata:{uploadSource:'hoswing-mcp'}}});
      record.sessionId=id(session.id);await persist();
    }
    if(['CANCELED','EXPIRED'].includes(session.status))throw Error('UPLOAD_SESSION_'+session.status);
    if(['COMPLETING','FINALIZING'].includes(session.status))throw Error('UPLOAD_FINALIZING: 可稍后恢复同一任务。');
    if(!Number.isSafeInteger(session.chunkSize)||session.chunkSize<=0||session.chunkSize>8*1024*1024||!Array.isArray(session.missingChunks))throw Error('UPLOAD_PROTOCOL_MISMATCH');
    const handle=await fs.open(file,'r');
    try{
      for(const index of session.missingChunks){
        if(!Number.isInteger(index)||index<0||index*session.chunkSize>=stat.size)throw Error('INVALID_CHUNK_INDEX');
        const size=Math.min(session.chunkSize,stat.size-index*session.chunkSize);
        const buffer=Buffer.alloc(size);const {bytesRead}=await handle.read(buffer,0,size,index*session.chunkSize);
        if(bytesRead!==size)throw Error('ASSET_TRUNCATED_DURING_UPLOAD');
        await this.request(`/api/v1/asset-uploads/${id(session.id)}/chunks/${index}`,{method:'PUT',timeout:120000,upload:{base64:buffer.toString('base64'),name:path.basename(file)+'.'+index+'.part',mimeType:'application/octet-stream',sha256:createHash('sha256').update(buffer).digest('hex')}});
      }
    }finally{await handle.close();}
    const result=await this.request(`/api/v1/asset-uploads/${id(session.id)}/complete`,{method:'POST',timeout:120000});
    if(!result.asset?.current?.id)throw Error('UPLOAD_RECEIPT_MISSING_ASSET_VERSION');
    Object.assign(record,{assetVersionId:id(result.asset.current.id),assetId:result.asset.id,kind:info.kind});await persist();return record;
  }
  async download(assetVersionId,dir,stem,allowedIds){
    id(assetVersionId);
    if(!allowedIds.includes(assetVersionId))throw Error('ASSET_NOT_IN_JOB_RECEIPT');
    const page=await this.selectPage();
    // Refresh/validate through the browser, then keep the bearer in process memory only.
    await this.request('/api/v1/auth/me');
    const token=await page.evaluate(()=>sessionStorage.getItem('mangahermes.accessToken'));
    const response=await fetch(`${BASE}/api/v1/asset-versions/${encodeURIComponent(assetVersionId)}/content`,{headers:{authorization:'Bearer '+token},redirect:'manual',signal:AbortSignal.timeout(300000)});
    // Never send the bearer to CDN or arbitrary redirects. A changing download protocol fails closed.
    if(!response.ok)throw Error(`DOWNLOAD_HTTP_${response.status}`);
    const mime=(response.headers.get('content-type')||'').split(';')[0].trim();
    const ext={'video/mp4':'.mp4','video/webm':'.webm','video/quicktime':'.mov','image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','audio/mpeg':'.mp3','audio/wav':'.wav','audio/x-wav':'.wav','audio/mp4':'.m4a'}[mime];
    if(!ext)throw Error('UNEXPECTED_DOWNLOAD_CONTENT_TYPE: '+mime);
    await fs.mkdir(dir,{recursive:true});
    const target=path.join(dir,safeName(stem)+'_'+safeName(assetVersionId)+ext);
    const partial=target+'.'+randomUUID()+'.part';
    let bytes=0;const hash=createHash('sha256');
    async function* checked(source){for await(const chunk of source){bytes+=chunk.length;if(bytes>2*1024**3)throw Error('DOWNLOAD_EXCEEDS_2GB');hash.update(chunk);yield chunk;}}
    try{
      await pipeline(Readable.fromWeb(response.body),checked,createWriteStream(partial,{flags:'wx'}));
      const length=response.headers.get('content-length');
      if(!bytes||(length&&Number(length)!==bytes))throw Error('DOWNLOAD_LENGTH_MISMATCH');
      // Exclusive link avoids overwriting a previous download or user-created file.
      await fs.link(partial,target);await fs.unlink(partial);
      return {path:target,bytes,sha256:hash.digest('hex'),assetVersionId,mime};
    }catch(e){await fs.unlink(partial).catch(()=>{});throw e;}
  }
  async screenshot(file=path.join(ROOT,'diagnostics','hoswing.png')){
    const page=await this.selectPage();await fs.mkdir(path.dirname(file),{recursive:true});await page.screenshot({path:file,fullPage:true});return {path:file,url:page.url()};
  }
  async disconnect(){if(this.browser)await this.browser.close();this.browser=null;this.page=null;}
}
