import asyncio
import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from mcp.server.fastmcp import FastMCP
import server
from canvas_video import register,patch_canvas,project_state,media_url

def fixture():
    card={'id':'t1','kind':'text','data':'old','label':'note','x':0,'y':0,'width':400,'height':200,'metadata':{'custom':'keep'}}
    image={'id':'i1','kind':'image','data':'/uploads/reference.png','label':'ref','x':500,'y':0,'width':400,'height':300,'metadata':{'asset_version_id':'v1'}}
    elements=[card,image]
    return {'id':'p1','revision_no':3,'title':'test','canvas_data':json.dumps(elements),'workflow_state':{'activeMode':'industrial','modes':{'industrial':{'elements':copy.deepcopy(elements),'messages':[{'content':'keep'}],'dagState':{'edges':[{'source':'a','target':'b'}]}},'ai_video':{'elements':[],'messages':[]}},'custom':{'a':1}}}

class Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.project=fixture();self.posts=[]
        self.page=SimpleNamespace(evaluate=AsyncMock(return_value={'supported':True,'estimated_points':30,'engine':'video-claw'}))
        self.browser=SimpleNamespace(lock=asyncio.Lock(),get=AsyncMock(return_value=self.page),api=AsyncMock(side_effect=self.api))
        self.host=SimpleNamespace(DATA=Path(self.tmp.name),browser=self.browser,identifier=server.identifier,clean=server.clean,READ=server.READ,WRITE=server.WRITE)
        self.tools=register(FastMCP('test'),self.host)
        self.task={'status':'completed','result':{'final_video_url':'/uploads/result.mp4','script':{'title':'demo'}}}
        self.fail_post=False;self.fail_put=False
    async def asyncTearDown(self): self.tmp.cleanup()
    async def api(self,path,method='GET',body=None,**kwargs):
        if path=='/api/design/p1':
            if method=='PUT':
                self.posts.append((path,body))
                if self.fail_put: raise TimeoutError()
                if body['expected_revision']!=self.project['revision_no']: raise RuntimeError('409')
                self.project.update({k:copy.deepcopy(body[k]) for k in ['canvas_data','workflow_state','title']})
                self.project['revision_no']+=1
                return {'success':True,'revision_no':self.project['revision_no']}
            return {'project':copy.deepcopy(self.project)}
        if path=='/api/auth/me': return {'user':{'id':1}}
        if path=='/api/models/generate-video':
            self.posts.append((path,body))
            if self.fail_post: raise TimeoutError()
            return {'task_id':'task1'}
        if path=='/api/models/tasks/task1': return self.task
        raise AssertionError(path)
    async def patch(self):
        return await self.tools['fengtu_canvas_prepare']('p1',[{'op':'update','id':'t1','changes':{'data':'new','x':10}}])
    async def video(self):
        return await self.tools['fengtu_video_prepare']('p1',['i1'],'Demo')
    async def test_preserves_modes_metadata_and_dag(self):
        before=project_state({'project':fixture()},'p1')
        after,_=patch_canvas(before,'industrial',[{'op':'update','id':'t1','changes':{'x':10}}])
        self.assertEqual(before['canvas_data'][0]['x'],0)
        self.assertEqual(after['workflow_state']['modes']['ai_video'],before['workflow_state']['modes']['ai_video'])
        self.assertEqual(after['workflow_state']['modes']['industrial']['dagState'],before['workflow_state']['modes']['industrial']['dagState'])
        self.assertEqual(after['canvas_data'][0]['metadata'],{'custom':'keep'})
        self.assertEqual(after['canvas_data'],after['workflow_state']['modes']['industrial']['elements'])
    async def test_inactive_mode_does_not_replace_visible_canvas(self):
        state=project_state(fixture(),'p1');after,_=patch_canvas(state,'ai_video',[{'op':'add','element':{'kind':'text','data':'x','x':0,'y':0,'width':10,'height':10}}])
        self.assertEqual(after['canvas_data'],state['canvas_data'])
        self.assertEqual(len(after['workflow_state']['modes']['ai_video']['elements']),1)
    async def test_prepare_is_local(self):
        await self.patch();self.assertEqual(self.posts,[])
    async def test_apply_readback(self):
        p=await self.patch();out=await self.tools['fengtu_canvas_apply'](p['patch_id'],True)
        self.assertEqual(out['state'],'applied');self.assertEqual(out['revision'],4)
        self.assertEqual(json.loads(self.project['canvas_data'])[0]['data'],'new')
        await self.tools['fengtu_canvas_apply'](p['patch_id'],True);self.assertEqual(len(self.posts),1)
    async def test_revision_conflict(self):
        p=await self.patch();self.project['revision_no']+=1
        with self.assertRaises(ValueError): await self.tools['fengtu_canvas_apply'](p['patch_id'],True)
        self.assertEqual(self.posts,[])
    async def test_uncertain_canvas_no_retry(self):
        p=await self.patch();self.fail_put=True
        out=await self.tools['fengtu_canvas_apply'](p['patch_id'],True);self.assertEqual(out['state'],'uncertain')
        await self.tools['fengtu_canvas_apply'](p['patch_id'],True);self.assertEqual(len(self.posts),1)
    async def test_remove_reorder(self):
        state=project_state(fixture(),'p1')
        after,_=patch_canvas(state,'industrial',[{'op':'reorder','id':'i1','index':0},{'op':'remove','id':'t1'}])
        self.assertEqual([e['id'] for e in after['canvas_data']],['i1'])
    async def test_asset_overwrite_blocked(self):
        with self.assertRaises(ValueError): patch_canvas(project_state(fixture(),'p1'),'industrial',[{'op':'update','id':'i1','changes':{'data':'/uploads/new.png'}}])
    async def test_bad_geometry(self):
        with self.assertRaises(ValueError): patch_canvas(project_state(fixture(),'p1'),'industrial',[{'op':'update','id':'t1','changes':{'x':float('nan')}}])
    async def test_ambiguous_canvas_blocked(self):
        p=fixture();p['workflow_state']['modes']['industrial']['elements']=[]
        with self.assertRaises(ValueError): patch_canvas(project_state(p,'p1'),'industrial',[{'op':'remove','id':'t1'}])
    async def test_media_url(self):
        for url in ['http://127.0.0.1/x','https://evil.test/uploads/a.mp4','//evil.test/a','file:///x']:
            with self.assertRaises(ValueError): media_url(url)
    async def test_video_preparation_no_post(self):
        j=await self.video();self.assertEqual(j['payload']['reference_images'],['https://www.fengtu-ai.com/uploads/reference.png']);self.assertEqual(self.posts,[])
    async def test_video_approval(self):
        j=await self.video()
        with self.assertRaises(ValueError): await self.tools['fengtu_video_submit'](j['job_id'],True,30,False)
        self.assertEqual(self.posts,[])
    async def test_video_budget(self):
        j=await self.video()
        with self.assertRaises(ValueError): await self.tools['fengtu_video_submit'](j['job_id'],True,29,True)
    async def test_video_source_changed(self):
        j=await self.video();p=self.project['workflow_state']['modes']['industrial']['elements'];p[1]['data']='/uploads/new.png';self.project['canvas_data']=json.dumps(p)
        with self.assertRaises(ValueError): await self.tools['fengtu_video_submit'](j['job_id'],True,30,True)
    async def test_video_uncertain_never_resends(self):
        j=await self.video();self.fail_post=True
        result=await self.tools['fengtu_video_submit'](j['job_id'],True,30,True);self.assertEqual(result['state'],'uncertain')
        await self.tools['fengtu_video_submit'](j['job_id'],True,30,True);self.assertEqual(len(self.posts),1)
    async def test_video_completion_and_insertion(self):
        j=await self.video();await self.tools['fengtu_video_submit'](j['job_id'],True,30,True)
        result=await self.tools['fengtu_video_get_job'](j['job_id']);self.assertEqual(result['state'],'completed')
        patch=await self.tools['fengtu_video_add_to_canvas'](j['job_id']);self.assertEqual(len(patch['changes']),2)
        result=await self.tools['fengtu_canvas_apply'](patch['patch_id'],True);self.assertEqual(result['state'],'applied')
    async def test_clips_only_is_partial(self):
        j=await self.video();await self.tools['fengtu_video_submit'](j['job_id'],True,30,True)
        self.task={'status':'completed','result':{'clips':[{'video_url':'/uploads/clip.mp4'}]}}
        result=await self.tools['fengtu_video_get_job'](j['job_id']);self.assertEqual(result['state'],'partial')
    async def test_task_failure_is_terminal(self):
        j=await self.video();await self.tools['fengtu_video_submit'](j['job_id'],True,30,True)
        self.task={'status':'failed','error':'generation failed'}
        result=await self.tools['fengtu_video_get_job'](j['job_id']);self.assertEqual(result['state'],'failed')

if __name__=='__main__': unittest.main()
