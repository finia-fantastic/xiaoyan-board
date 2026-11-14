import copy
import hashlib
import json
import math
import re
import uuid
from pathlib import Path
from urllib.parse import urlsplit
import httpx

MODES={'industrial','digital_ux','service_design','visual_brand','ich_ip','fashion','architecture','interior_design','ai_video'}
FIELDS={'x','y','width','height','rotation','label','data'}

def digest(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,allow_nan=False).encode()).hexdigest()

def decoded(value,default):
    return json.loads(value) if isinstance(value,str) else copy.deepcopy(default if value is None else value)

def project_state(reply,pid):
    p=reply.get('project',reply)
    if p.get('id')!=pid: raise ValueError('Project ID mismatch')
    rev=p.get('revision_no')
    if type(rev) is not int or rev<1: raise ValueError('Missing revision; edit blocked')
    elements=decoded(p.get('canvas_data'),[])
    workflow=decoded(p.get('workflow_state'),{})
    if not isinstance(elements,list) or not isinstance(workflow,dict): raise ValueError('Unknown canvas schema')
    return {'canvas_data':elements,'workflow_state':workflow,'title':p.get('title',''),'revision_no':rev}

def select_mode(state,mode):
    wf=state['workflow_state'];active=wf.get('activeMode') or wf.get('designMode');mode=mode or active
    if mode not in MODES: raise ValueError('Specify supported design mode')
    modes=wf.get('modes',{})
    if mode in modes:
        elements=modes[mode].get('elements')
        if not isinstance(elements,list): raise ValueError('Invalid mode elements')
        if mode==active and elements!=state['canvas_data']: raise ValueError('Active mode differs from canvas; save/reload website first')
    elif not modes and (not active or active==mode): elements=state['canvas_data']
    else: raise ValueError('Requested mode does not exist')
    if any(not isinstance(e,dict) or not isinstance(e.get('id'),str) for e in elements): raise ValueError('Unknown element schema')
    if len({e['id'] for e in elements})!=len(elements): raise ValueError('Duplicate element IDs')
    return mode,elements,active

def media_url(value):
    if not isinstance(value,str): raise ValueError('Media URL must be text')
    if value.startswith('/uploads/'): value='https://www.fengtu-ai.com'+value
    u=urlsplit(value)
    if u.scheme!='https' or u.hostname!='www.fengtu-ai.com' or u.username or u.password or not u.path.startswith('/uploads/'):
        raise ValueError('Only existing same-site /uploads/ media supported')
    return value

def validate_element(e):
    if e.get('kind') not in {'text','image'}: raise ValueError('Only text/image/video cards can be edited')
    if not isinstance(e.get('data'),str) or not isinstance(e.get('label',''),str): raise ValueError('Invalid content')
    if len(e['data'])>100000: raise ValueError('Card content too large')
    for key in ['x','y','width','height','rotation']:
        v=e.get(key,0 if key=='rotation' else None)
        if type(v) not in {int,float} or not math.isfinite(v): raise ValueError('Invalid '+key)
        if key in {'width','height'} and not 1<=v<=20000: raise ValueError('Invalid dimensions')
        if key in {'x','y'} and abs(v)>1000000: raise ValueError('Position out of range')
    if e['kind']=='image' and not e.get('data','').startswith('data:image/'):
        media_url(e['data'])

def patch_canvas(state,mode,operations):
    if not 1<=len(operations)<=100: raise ValueError('Use 1..100 operations')
    result=copy.deepcopy(state);mode,elements,active=select_mode(result,mode)
    changed=copy.deepcopy(elements);summary=[]
    for op in operations:
        action=op.get('op');eid=op.get('id')
        if action=='add':
            e=copy.deepcopy(op.get('element',{}))
            if set(e)-({'id','kind','mediaType','editable'}|FIELDS): raise ValueError('Unsupported new-card fields')
            e.setdefault('id','mcp_'+uuid.uuid4().hex)
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',e['id']): raise ValueError('Invalid element ID')
            if any(x['id']==e['id'] for x in changed): raise ValueError('Element exists')
            e.setdefault('rotation',0);e.setdefault('label','');e.setdefault('editable',e.get('kind')=='text')
            if 'mediaType' in e and (e['mediaType']!='video' or e.get('kind')!='image'): raise ValueError('Invalid media type')
            if e.get('kind')=='image': media_url(e.get('data'))
            validate_element(e);changed.append(e);eid=e['id']
        else:
            matches=[i for i,e in enumerate(changed) if e['id']==eid]
            if len(matches)!=1: raise ValueError('Target missing or ambiguous')
            i=matches[0];e=changed[i]
            if e.get('kind') not in {'text','image'}: raise ValueError('AI workflow nodes cannot be changed by card edits')
            if action=='update':
                updates=op.get('changes',{})
                if not updates or set(updates)-FIELDS: raise ValueError('Unsupported fields')
                if 'data' in updates and e['kind']=='image': raise ValueError('Add new media instead of replacing asset provenance')
                if 'data' in updates and (e.get('editable') is False or e.get('metadata',{}).get('readOnly')): raise ValueError('Read-only content')
                e.update(updates);validate_element(e)
            elif action=='remove': changed.pop(i)
            elif action=='reorder':
                index=op.get('index')
                if type(index) is not int or not 0<=index<len(changed): raise ValueError('Invalid order')
                changed.insert(index,changed.pop(i))
            else: raise ValueError('Unknown operation')
        summary.append({'op':action,'id':eid})
    wf=result['workflow_state']
    if mode in wf.get('modes',{}): wf['modes'][mode]['elements']=changed
    if mode==active or not wf.get('modes'): result['canvas_data']=changed
    return result,summary

def video_result(task):
    result=task.get('result') or {}
    if not isinstance(result,dict): return None,[],{}
    nested=result.get('result') if isinstance(result.get('result'),dict) else {}
    url=result.get('final_video_url') or result.get('video_url') or nested.get('final_video_url') or nested.get('video_url')
    return url,result.get('clips') or nested.get('clips') or [],result

def register(mcp,host):
    def store(record):
        folder=host.DATA/'operations';folder.mkdir(parents=True,exist_ok=True)
        dest=folder/(host.identifier(record['id'])+'.json')
        temp=dest.with_suffix('.tmp');temp.write_text(json.dumps(record,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8');temp.replace(dest)

    def read(op_id,kind):
        record=json.loads((host.DATA/'operations'/(host.identifier(op_id)+'.json')).read_text(encoding='utf-8'))
        if record['kind']!=kind: raise ValueError('Wrong operation type')
        return record

    async def fetch_project(pid):
        host.identifier(pid)
        if pid.startswith('local_'): raise ValueError('Cloud projects only')
        reply=await host.browser.api('/api/design/'+pid,raw=True)
        return project_state(reply,pid)

    async def prepare_patch(pid,mode,operations):
        state=await fetch_project(pid)
        mode,_,_=select_mode(state,mode)
        after,summary=patch_canvas(state,mode,operations)
        record={'id':uuid.uuid4().hex,'kind':'canvas','state':'draft','project_id':pid,'mode':mode,'base':state,'after':after,'base_hash':digest(state),'summary':summary}
        store(record)
        return {'patch_id':record['id'],'state':'draft','project_id':pid,'mode':mode,'base_revision':state['revision_no'],'changes':summary,'no_change':after==state}

    @mcp.tool(annotations=host.READ)
    async def fengtu_canvas_read(project_id:str,mode:str='')->dict:
        """Read a cloud canvas mode with its revision and card IDs. Media data URIs are omitted only in tool output, never in saved patches."""
        async with host.browser.lock:
            state=await fetch_project(project_id)
            mode,elements,active=select_mode(state,mode)
            return {'project_id':project_id,'revision':state['revision_no'],'mode':mode,'active_mode':active,'available_modes':list(state['workflow_state'].get('modes',{})),'elements':host.clean(elements)}

    @mcp.tool(annotations=host.WRITE)
    async def fengtu_canvas_prepare(project_id:str,operations:list[dict],mode:str='')->dict:
        """Prepare LOCAL edits without cloud writes. Operations: {op:add,element:{kind:text|image,data,label,x,y,width,height,mediaType?:video}}, {op:update,id,changes:{x,y,width,height,rotation,label,data}}, {op:remove,id}, {op:reorder,id,index}. Preserve other modes and metadata."""
        async with host.browser.lock:
            return await prepare_patch(project_id,mode,operations)

    @mcp.tool(annotations=host.WRITE)
    async def fengtu_canvas_apply(patch_id:str,approved:bool)->dict:
        """Apply a reviewed patch once, with original backup, expected_revision and readback. Requires authorization for listed changes. Conflicts stop; never overwrites a newer edit."""
        async with host.browser.lock:
            p=read(patch_id,'canvas')
            if p['state']!='draft': return {'patch_id':patch_id,'state':p['state'],'message':'Already attempted; inspect with canvas_patch_status'}
            if not approved: raise ValueError('Authorization for these canvas changes required')
            current=await fetch_project(p['project_id'])
            if digest(current)!=p['base_hash']: raise ValueError('Project changed; prepare a fresh patch')
            if p['after']==p['base']:
                p['state']='unchanged';store(p);return {'patch_id':patch_id,'state':'unchanged'}
            body={k:v for k,v in p['after'].items() if k in {'workflow_state','title'}}
            body.update(canvas_data=json.dumps(p['after']['canvas_data'],ensure_ascii=False),expected_revision=current['revision_no'])
            p['state']='saving';store(p)
            try:
                result=await host.browser.api('/api/design/'+p['project_id'],method='PUT',body=body)
                if not result.get('success') or type(result.get('revision_no')) is not int: raise ValueError('Save did not acknowledge revision')
                p['saved_revision']=result['revision_no'];store(p)
                observed=await fetch_project(p['project_id'])
                keys=['canvas_data','workflow_state','title']
                p['state']='applied' if all(observed[k]==p['after'][k] for k in keys) else 'verification_required'
                p['observed_revision']=observed['revision_no'];store(p)
            except Exception as e:
                p['state']='uncertain';p['error_type']=type(e).__name__;store(p)
            return {'patch_id':patch_id,'state':p['state'],'revision':p.get('observed_revision'),'backup':str(host.DATA/'operations'/(patch_id+'.json')),'message':'Refresh the project in the website to see the saved canvas; no auto-resend.'}

    @mcp.tool(annotations=host.READ)
    async def fengtu_canvas_patch_status(patch_id:str)->dict:
        """Reconcile a previously saved/uncertain patch against cloud data; never performs a save."""
        async with host.browser.lock:
            p=read(patch_id,'canvas');current=await fetch_project(p['project_id'])
            keys=['canvas_data','workflow_state','title']
            matches=all(current[k]==p['after'][k] for k in keys)
            if matches and p['state'] in {'saving','uncertain','verification_required'}:
                p['state']='applied';p['observed_revision']=current['revision_no'];store(p)
            return {'patch_id':patch_id,'state':p['state'],'matches_proposed':matches,'matches_original':digest(current)==p['base_hash'],'current_revision':current['revision_no'],'changes':p['summary']}

    async def video_catalog():
        page=await host.browser.get()
        evidence=await page.evaluate(r'''async () => {
          const script=[...document.scripts].find(s=>new URL(s.src||location.href).origin===location.origin && /\/assets\/main-[^/]+\.js$/.test(new URL(s.src||location.href).pathname));
          if(!script)return {supported:false,reason:'Current frontend bundle not found'};
          const r=await fetch(script.src,{signal:AbortSignal.timeout(30000)});if(!r.ok)return {supported:false,reason:'Bundle unavailable'};
          const s=await r.text();
          const match=s.match(/model:"video-claw",estimatedTime:[0-9]+,pointsCost:([0-9]+(?:\.[0-9]+)?)/);
          return {supported:s.includes('/api/models/generate-video') && s.includes('/api/models/tasks/') && Boolean(match),engine:'video-claw',estimated_points:match?Number(match[1]):null,price_source:'current website frontend estimate; not a server quote',bundle:script.src,min_seconds:10,max_seconds:120};
        }''')
        return evidence

    @mcp.tool(annotations=host.READ)
    async def fengtu_video_capabilities()->dict:
        """Read the implemented video engine and price estimate from the current website bundle. This does not prove account availability or provide a hard spending cap."""
        async with host.browser.lock:
            result=await video_catalog()
            result['implemented']=['project_images_to_video','script2video','task_polling','video_download','prepare_canvas_insertion']
            result['live_generation_verified']=False
            return result

    @mcp.tool(annotations=host.WRITE)
    async def fengtu_video_prepare(project_id:str,element_ids:list[str],prompt:str,total_duration_seconds:int=30,video_type:str='宣传片',mode:str='',scenes:int=4)->dict:
        """Prepare a LOCAL video task from existing cloud canvas image IDs. No generation/upload. Video Claw script2video, 10..120 seconds. Explicit source IDs avoid sending unrelated project images."""
        async with host.browser.lock:
            if not prompt.strip() or len(prompt)>30000: raise ValueError('Prompt must contain 1..30000 characters')
            if type(total_duration_seconds) is not int or not 10<=total_duration_seconds<=120: raise ValueError('Duration must be 10..120 seconds')
            if type(scenes) is not int or not 1<=scenes<=12: raise ValueError('Use 1..12 scenes')
            if video_type not in {'宣传片','广告片','故事片'}: raise ValueError('Unsupported video type')
            if not 1<=len(element_ids)<=20 or len(set(element_ids))!=len(element_ids): raise ValueError('Select 1..20 unique image IDs')
            state=await fetch_project(project_id);mode,elements,_=select_mode(state,mode)
            by_id={e['id']:e for e in elements};sources=[]
            for eid in element_ids:
                e=by_id.get(eid)
                if not e or e.get('kind')!='image' or e.get('mediaType')=='video': raise ValueError('Source must be an existing image card: '+eid)
                u=media_url(e.get('data'))
                if Path(urlsplit(u).path).suffix.lower() not in {'.png','.jpg','.jpeg','.webp'}: raise ValueError('Select PNG/JPEG/WebP images')
                sources.append({'id':eid,'url':u,'label':e.get('label',''),'hash':digest(e)})
            pricing=await video_catalog()
            if not pricing.get('supported'): raise ValueError('Video API contract not detected in current frontend')
            payload={'prompt':prompt.strip(),'image_url':sources[-1]['url'],'reference_images':[s['url'] for s in sources],'source_design_mode':mode,'video_type':video_type,'design_description':'；'.join(s['label'] for s in sources),'total_duration_seconds':total_duration_seconds,'engine':'video-claw','vimax_mode':'script2video','vimax_scenes':scenes,'active_skills':['video-claw','vimax-video-director']}
            job={'id':uuid.uuid4().hex,'kind':'video','state':'draft','project_id':project_id,'mode':mode,'sources':sources,'payload':payload,'pricing':pricing,'task_id':None}
            store(job)
            return {'job_id':job['id'],'state':'draft','payload':payload,'pricing':pricing,'warning':'Frontend estimate only. Server-side hard budget enforcement is unavailable; submission requires acknowledgement.'}

    @mcp.tool(annotations=host.WRITE)
    async def fengtu_video_submit(job_id:str,approved:bool,max_points:float,accept_estimated_price:bool=False)->dict:
        """Submit a prepared video ONCE after user approves prompt/source images/budget and accepts estimate-only pricing. No automatic retry; an uncertain POST without task_id requires website support."""
        async with host.browser.lock:
            job=read(job_id,'video')
            if job['state']!='draft': return {'job_id':job_id,'state':job['state'],'task_id':job.get('task_id'),'message':'Already attempted. No resubmission.'}
            if not approved or not accept_estimated_price: raise ValueError('User must authorize this video and acknowledge estimate-only pricing')
            if type(max_points) not in {int,float} or not math.isfinite(max_points) or max_points<0: raise ValueError('Invalid points budget')
            pricing=await video_catalog();n=pricing.get('estimated_points')
            if not pricing.get('supported') or type(n) not in {int,float} or not math.isfinite(n) or n<0: raise ValueError('Current estimate unavailable')
            if n>max_points: raise ValueError('Current estimate exceeds approved budget')
            state=await fetch_project(job['project_id']);_,elements,_=select_mode(state,job['mode']);current={e['id']:e for e in elements}
            for source in job['sources']:
                if source['id'] not in current or digest(current[source['id']])!=source['hash']: raise ValueError('Source image changed; prepare again')
            await host.browser.api('/api/auth/me')
            job.update(state='submitting',approved_max_points=max_points,submission_pricing=pricing);store(job)
            try:
                response=await host.browser.api('/api/models/generate-video',method='POST',body=job['payload'])
                tid=response.get('task_id')
                if not isinstance(tid,str) or not tid: raise ValueError('No task ID in response')
                host.identifier(tid)
                job.update(state='submitted',task_id=tid);store(job)
            except Exception as e:
                job.update(state='uncertain',error_type=type(e).__name__);store(job)
            return {'job_id':job_id,'state':job['state'],'task_id':job.get('task_id'),'message':'Query the same job; never recreate it to retry an uncertain submission.'}

    @mcp.tool(annotations=host.READ)
    async def fengtu_video_get_job(job_id:str)->dict:
        """Poll the original task once. Distinguishes completed movie, clips-only partial result and failed task; never submits."""
        async with host.browser.lock:
            job=read(job_id,'video')
            if not job.get('task_id'): return {'job_id':job_id,'state':job['state'],'message':'No server task ID recorded. Do not resubmit an uncertain job.'}
            task=await host.browser.api('/api/models/tasks/'+host.identifier(job['task_id']))
            status=task.get('status');job['server_status']=status
            if status=='completed':
                url,clips,result=video_result(task)
                job.update(state='completed' if url else 'partial' if clips else 'result_missing',result=result,video_url=url,clips=clips)
            elif status=='failed': job.update(state='failed',error=host.clean(task.get('error','Video task failed')))
            job['progress']=task.get('progress');job['message']=task.get('message');store(job)
            return host.clean(job)

    @mcp.tool(annotations=host.WRITE)
    async def fengtu_video_add_to_canvas(job_id:str,target_project_id:str='',mode:str='',x:float=120,y:float=180)->dict:
        """Prepare a LOCAL canvas patch inserting completed movie or successful clips and script. Apply with canvas_apply; does not generate again or save automatically."""
        async with host.browser.lock:
            job=read(job_id,'video')
            if job['state'] not in {'completed','partial'}: raise ValueError('Read the successful video result first')
            pid=target_project_id or job['project_id'];mode=mode or job['mode']
            urls=[job['video_url']] if job.get('video_url') else [c.get('video_url') or c.get('video_path') for c in job.get('clips',[]) if isinstance(c,dict)]
            urls=[u for u in urls if u]
            if not urls: raise ValueError('No downloadable movie or clips')
            ops=[]
            for index,url in enumerate(urls):
                ops.append({'op':'add','element':{'id':f'mcp_video_{job_id}_{index}','kind':'image','mediaType':'video','data':media_url(url),'label':'最终成片' if job['state']=='completed' else f'片段 {index+1}（非最终成片）','x':x+index*640,'y':y,'width':600,'height':337,'rotation':0,'editable':False}})
            result=job.get('result',{});script=result.get('script') or result.get('result',{}).get('script')
            if script:
                ops.append({'op':'add','element':{'id':f'mcp_script_{job_id}','kind':'text','data':json.dumps(script,ensure_ascii=False,indent=2),'label':'视频脚本与镜头清单','x':x,'y':y+380,'width':600,'height':500,'rotation':0,'editable':True}})
            return await prepare_patch(pid,mode,ops)

    @mcp.tool(annotations=host.WRITE)
    async def fengtu_video_download(job_id:str,clip_index:int=-1)->dict:
        """Download a completed movie or one successful clip into data/downloads, without rendering locally. Same-site media only; max 500 MB."""
        async with host.browser.lock:
            job=read(job_id,'video')
            if job['state'] not in {'completed','partial'}: raise ValueError('No completed media')
            if type(clip_index) is not int or clip_index< -1: raise ValueError('Invalid clip index')
            url=job.get('video_url')
            if clip_index>=0:
                clips=job.get('clips',[])
                if clip_index>=len(clips): raise ValueError('Clip index out of range')
                url=clips[clip_index].get('video_url') or clips[clip_index].get('video_path')
            if not url: raise ValueError('No final movie; select a successful clip')
            url=media_url(url);suffix=Path(urlsplit(url).path).suffix.lower()
            if suffix not in {'.mp4','.webm','.mov','.m4v'}: raise ValueError('Unsupported video extension')
            folder=host.DATA/'downloads';folder.mkdir(parents=True,exist_ok=True)
            dest=folder/(job_id+('_final' if clip_index==-1 else f'_clip{clip_index}')+suffix)
            if dest.exists(): return {'path':str(dest),'existing':True}
            temp=dest.with_name(dest.name+'.'+uuid.uuid4().hex+'.partial');total=0
            try:
                async with httpx.AsyncClient(timeout=120,follow_redirects=False,trust_env=False) as client:
                    async with client.stream('GET',url) as response:
                        response.raise_for_status()
                        if not response.headers.get('content-type','').startswith('video/'): raise ValueError('Expected video response')
                        with temp.open('xb') as stream:
                            async for chunk in response.aiter_bytes():
                                total+=len(chunk)
                                if total>500*1024*1024: raise ValueError('Video exceeds 500 MB')
                                stream.write(chunk)
                temp.replace(dest)
            except Exception:
                temp.unlink(missing_ok=True);raise
            return {'path':str(dest),'bytes':total}

    return {name:fn for name,fn in locals().items() if name.startswith('fengtu_') and callable(fn)}
