import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, DEFAULT_PROJECT, id, loadStoryboard, normalizeRows, mediaInfo, saveJob, readJob, summary, buildNode, quoteBody, quoteCredits, reserve, lockJob, TERMINAL, writeJson } from './core.mjs';

// 网站会把对象键重排（实测 modelParameters 写 {aspectRatio,count} 读回 {count,aspectRatio}）。
// 比较写回结果时必须忽略键顺序，否则会把"保存成功"误判成"节点被改过"。
export function stable(value){
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
  return JSON.stringify(value);
}

export class Pipeline {
  constructor(api){this.api=api;}
  route(projectId,suffix=''){return `/api/v1/projects/${id(projectId)}${suffix}`;}
  async create({projectId=DEFAULT_PROJECT,storyboardPath,shots,assetDir,mode='video',provider,modelId,operation,parameters={},outputDir}){
    if(!!storyboardPath===!!shots)throw Error('PROVIDE_STORYBOARD_PATH_OR_SHOTS');
    if(operation && !(mode==='image'?['image.generate','image.edit']:['video.generate']).includes(operation))throw Error('MODE_OPERATION_MISMATCH');
    const rows=storyboardPath?await loadStoryboard(storyboardPath,mode):normalizeRows(shots,{baseDir:assetDir||process.cwd(),mode});
    if(mode==='image'&&rows.some(s=>s.firstFrame||s.lastFrame))throw Error('FIRST_LAST_FRAME_REQUIRE_VIDEO_MODE');
    const jobId='job-'+randomUUID();
    const assets={};
    for(const file of new Set(rows.flatMap(s=>[...s.references,s.firstFrame,s.lastFrame].filter(Boolean)))){
      const stat=await fs.stat(file);if(!stat.isFile()||!stat.size)throw Error('ASSET_FILE_EMPTY_OR_INVALID: '+file);
      assets[file]={size:stat.size,mtime:stat.mtimeMs,kind:mediaInfo(file).kind};
    }
    const job={id:jobId,projectId:id(projectId),status:'draft',mode,provider,modelId,operation:operation||(mode==='image'?'image.generate':'video.generate'),parameters,
      outputDir:path.resolve(outputDir||path.join(ROOT,'outputs',jobId)),origin:{x:0,y:0},assets,
      shots:rows.map(s=>({...s,status:'pending'})),reservedCredits:0,createdAt:new Date().toISOString()};
    await saveJob(job);return summary(job);
  }
  async models(projectId=DEFAULT_PROJECT){return this.api.request(this.route(projectId,'/providers/models?includeDisabled=true'));}
  async validateModel(job){
    const catalog=await this.models(job.projectId);
    const model=catalog.items?.find(m=>m.provider===job.provider&&m.modelId===job.modelId&&m.operation===job.operation);
    if(!model||!model.enabled||model.mock)throw Error('MODEL_NOT_AVAILABLE: 必须从当前项目模型目录选择已启用、非演示模型。');
    return model;
  }
  async quote(jobId){return lockJob(jobId,async()=>{
    const job=await readJob(jobId);
    if(job.shots.some(s=>s.key||s.jobId))throw Error('JOB_ALREADY_STARTED');
    await this.api.selectPage(job.projectId);
    const me=await this.api.request('/api/v1/auth/me');if(!me.id)throw Error('LOGIN_REQUIRED');job.accountId=me.id;
    await this.validateModel(job);
    let total=0;
    for(const shot of job.shots){shot.quote=await this.api.request(this.route(job.projectId,'/providers/quote'),{method:'POST',body:quoteBody(job,shot)});total+=quoteCredits(shot.quote);}
    job.quoteTotal=total;job.quotedAt=new Date().toISOString();job.status='quoted';await saveJob(job);return summary(job);
  });}
  async prepareStart(jobId,maxCredits){return lockJob(jobId,async()=>{
    const job=await readJob(jobId);
    if(!job.quotedAt)throw Error('QUOTE_REQUIRED');
    if(['completed','canceled','cancel-requested','failed'].includes(job.status))throw Error('JOB_TERMINAL: 已完成、已取消或明确失败的任务不自动重新生成。');
    if(!Number.isFinite(maxCredits)||maxCredits<job.reservedCredits||maxCredits<job.quoteTotal)throw Error('BUDGET_BELOW_QUOTE_OR_RESERVATION');
    job.approvedMaxCredits=maxCredits;job.status='starting';delete job.error;
    await fs.unlink(this.stopPath(jobId)).catch(e=>{if(e.code!=='ENOENT')throw e;});
    await saveJob(job);return summary(job);
  });}
  stopPath(jobId){return path.join(ROOT,'jobs',id(jobId)+'.stop');}
  async stop(jobId){
    await readJob(jobId);await fs.writeFile(this.stopPath(jobId),'stop');
    try {
      return await lockJob(jobId,async()=>{
        const job=await readJob(jobId);
        if(job.status==='completed'||job.status==='canceled')return summary(job);
        for(const [index,shot] of job.shots.entries()){
          if(shot.key&&!shot.jobId){await this.api.selectPage(job.projectId);await this.checkAccount(job);await this.submit(job,shot,index);}
          if(shot.jobId&&!TERMINAL.has(shot.status)&&shot.status!=='downloaded'){
            await this.api.selectPage(job.projectId);await this.cancelShot(job,shot);
          }
        }
        job.status=job.shots.some(s=>s.jobId&&!TERMINAL.has(s.status)&&s.status!=='downloaded')?'cancel-requested':'canceled';
        await saveJob(job);return summary(job);
      });
    } catch(e){
      if(!e.message.startsWith('JOB_LOCKED'))throw e;
      return {jobId,stopRequested:true,note:'已通知工作进程停止后续镜头并请求取消当前任务；需查询状态确认。'};
    }
  }
  async stopped(jobId){try{await fs.access(this.stopPath(jobId));return true;}catch{return false;}}
  async checkAccount(job){
    const me=await this.api.request('/api/v1/auth/me');if(me.id!==job.accountId)throw Error('ACCOUNT_CHANGED');
  }
  async receipt(job,shot,data){
    if(!data?.jobId||data.nodeId!==shot.node.id||(data.projectId&&data.projectId!==job.projectId)||(shot.jobId&&data.jobId!==shot.jobId))throw Error('TASK_RECEIPT_IDENTITY_MISMATCH');
    shot.jobId=id(data.jobId);shot.status=data.status||'queued';
    if(data.status==='succeeded'){
      if(!Array.isArray(data.assetVersionIds)||!data.assetVersionIds.length)throw Error('SUCCESS_WITHOUT_ASSET_RECEIPT');
      shot.assetVersionIds=data.assetVersionIds.map(id);
    }
    if(TERMINAL.has(shot.status)&&shot.status!=='succeeded')shot.error=data.code||data.resultSummary||shot.status;
    await saveJob(job);
  }
  async submit(job,shot,index){
    if(shot.key){
      // An interrupted POST is never resent automatically, including a 404 acceptance lookup.
      const recovered=await this.api.request(this.route(job.projectId,`/node-execution-acceptance?idempotencyKey=${encodeURIComponent(shot.key)}`));
      await this.receipt(job,shot,recovered);return;
    }
    await this.checkAccount(job);
    const currentQuote=await this.api.request(this.route(job.projectId,'/providers/quote'),{method:'POST',body:quoteBody(job,shot)});
    const amount=quoteCredits(currentQuote);
    if(job.reservedCredits+amount>job.approvedMaxCredits)throw Error('APPROVED_CREDIT_BUDGET_EXCEEDED');
    const canvas=await this.api.request(this.route(job.projectId,'/canvas'));
    if(!Number.isInteger(canvas.revision)||!Array.isArray(canvas.nodes)||!Array.isArray(canvas.edges))throw Error('CANVAS_PROTOCOL_MISMATCH');
    if(index===0&&!job.originSet){job.origin={x:Math.max(0,...canvas.nodes.map(n=>(n.position?.x||0)+(n.size?.width||400)))+160,y:0};job.originSet=true;}
    shot.node??=buildNode(job,shot,index,job.assets);
    await saveJob(job);
    // 并发任务可能同时写画布：保存失败或被别的工作进程抢先时，重新取快照再试，最多 3 次。
    let saved=null,verified=null;
    for(let attempt=0;attempt<3;attempt++){
      const snap=attempt===0?canvas:await this.api.request(this.route(job.projectId,'/canvas'));
      saved=snap.nodes?.find(n=>n.id===shot.node.id);
      if(!saved){
        const document={revision:snap.revision,...snap.name?{name:snap.name}:{},viewport:snap.viewport,nodes:[...snap.nodes,shot.node],edges:snap.edges};
        try{
          await this.api.request(this.route(job.projectId,'/canvas'),{method:'PATCH',key:`mcp-canvas-${shot.node.id}-${snap.revision}`,body:document});
        }catch(e){
          // A failed/uncertain save is reconciled by readback, never by overwriting a newer revision.
          const check=await this.api.request(this.route(job.projectId,'/canvas'));
          if(!check.nodes?.some(n=>n.id===shot.node.id)){await new Promise(r=>setTimeout(r,1200));continue;}
        }
      }
      verified=await this.api.request(this.route(job.projectId,'/canvas'));
      saved=verified.nodes?.find(n=>n.id===shot.node.id);
      if(saved&&saved.data?.prompt===shot.node.data.prompt&&saved.data?.modelId===job.modelId&&saved.data?.modelProvider===job.provider&&saved.data?.modelOperation===job.operation&&stable(saved.data?.modelParameters)===stable(shot.node.data.modelParameters)&&stable(saved.data?.referenceAssetVersionIds)===stable(shot.node.data.referenceAssetVersionIds))break;
      saved=null;await new Promise(r=>setTimeout(r,1500));
    }
    if(!saved)throw Error('CANVAS_NODE_CHANGED_OR_NOT_SAVED');
    shot.node=saved;
    shot.request={node:saved,invocation:'canvas',upstream:[],canvasIncomingNodes:[],canvasIncomingEdges:[],canvasAncestorNodes:[],canvasRevision:verified.revision};
    reserve(job,amount);shot.reservedCredits=amount;shot.quote=currentQuote;shot.key='hoswing-mcp-'+randomUUID();shot.status='submitting';await saveJob(job);
    try{
      const response=await this.api.request(this.route(job.projectId,'/node-executions'),{method:'POST',key:shot.key,body:shot.request,timeout:30000});
      await this.receipt(job,shot,response);
    }catch(e){
      if(e.status>=400&&e.status<500&&![408,429].includes(e.status)){
        shot.status='failed';shot.error=e.message;await saveJob(job);throw e;
      }
      shot.status='acceptance-unknown';shot.error='提交结果待确认；仅查询原幂等键，不重新扣费提交。';await saveJob(job);
      throw Error('SUBMISSION_UNCONFIRMED: 使用同一任务恢复，禁止另建任务重试。');
    }
  }
  async downloadShot(job,shot,index){
    shot.files??=[];
    for(const assetId of shot.assetVersionIds||[]){
      if(shot.files.some(f=>f.assetVersionId===assetId))continue;
      const result=await this.api.download(assetId,job.outputDir,`${String(index+1).padStart(3,'0')}_${shot.title}`,shot.assetVersionIds);
      shot.files.push(result);await saveJob(job);
    }
    shot.status='downloaded';await saveJob(job);
  }
  async run(jobId,{pollMs=5000,maxWaitMs=7200000}={}){
    // 2026-11-11 用户确认网站可并行：去掉"全局只能跑一个"的限制，只保留每个任务自己的锁。
    // 并发写画布可能撞 revision，submit() 里已有读回校验与重试。
    return lockJob(jobId,async()=>{
      const job=await readJob(jobId);
      try{
        if(!Number.isFinite(job.approvedMaxCredits))throw Error('APPROVAL_REQUIRED');
        await this.api.selectPage(job.projectId);await this.checkAccount(job);await this.validateModel(job);
        job.status='running';delete job.error;await saveJob(job);
        for(const [file,record] of Object.entries(job.assets)){
          if(await this.stopped(jobId)){job.status='canceled';await saveJob(job);return summary(job);}
          await this.api.upload(file,job.projectId,record,()=>saveJob(job));
        }
        for(const [index,shot] of job.shots.entries()){
          if(shot.status==='downloaded')continue;
          if(await this.stopped(jobId)){
            if(shot.key&&!shot.jobId)await this.submit(job,shot,index);
            if(shot.jobId&&!TERMINAL.has(shot.status))await this.cancelShot(job,shot);
            job.status=shot.jobId&&!TERMINAL.has(shot.status)?'cancel-requested':'canceled';await saveJob(job);return summary(job);
          }
          if(TERMINAL.has(shot.status)&&shot.status!=='succeeded')throw Error(`SHOT_TERMINAL: ${shot.id}: ${shot.error||shot.status}`);
          if(!shot.jobId)await this.submit(job,shot,index);
          const deadline=Date.now()+maxWaitMs;
          while(!TERMINAL.has(shot.status)){
            if(await this.stopped(jobId)){await this.cancelShot(job,shot);job.status=TERMINAL.has(shot.status)?'canceled':'cancel-requested';await saveJob(job);return summary(job);}
            if(Date.now()>deadline)throw Error('JOB_WAIT_TIMED_OUT: 保留原任务号，可恢复查询。');
            await new Promise(resolve=>setTimeout(resolve,pollMs));
            await this.checkAccount(job);
            const result=await this.api.request(this.route(job.projectId,`/node-executions/${id(shot.jobId)}`));
            await this.receipt(job,shot,result);
          }
          if(shot.status!=='succeeded')throw Error(`SHOT_FAILED: ${shot.id}: ${shot.error||shot.status}`);
          await this.downloadShot(job,shot,index);
        }
        job.status='completed';await saveJob(job);
        await writeJson(path.join(job.outputDir,'manifest.json'),{projectId:job.projectId,jobId:job.id,shots:job.shots.map(s=>({id:s.id,title:s.title,prompt:s.prompt,jobId:s.jobId,files:s.files}))});
        return summary(job);
      }catch(e){
        job.status=job.shots.some(s=>TERMINAL.has(s.status)&&s.status!=='succeeded')?'failed':'paused';job.error=e.message;await saveJob(job);return summary(job);
      }
    });
  }
  async cancelShot(job,shot){
    await this.checkAccount(job);
    const response=await this.api.request(this.route(job.projectId,`/node-executions/${id(shot.jobId)}/cancel`),{method:'POST',key:`cancel-${job.projectId}-${shot.jobId}`});
    await this.receipt(job,shot,response);
  }
  async downloadCompleted(jobId){return lockJob(jobId,async()=>{
    const job=await readJob(jobId);await this.api.selectPage(job.projectId);await this.checkAccount(job);
    for(const [index,shot] of job.shots.entries()){
      if(shot.status==='succeeded')await this.downloadShot(job,shot,index);
    }
    await saveJob(job);return summary(job);
  });}
}
