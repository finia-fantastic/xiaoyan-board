import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

import server
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

class LocalTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.old_data=server.DATA;server.DATA=Path(self.temp.name)
        self.old_browser=server.browser
        self.fake=type('Fake',(),{})()
        self.fake.lock=asyncio.Lock()
        self.fake.api=AsyncMock(return_value={'text_points':2,'standard_image_points':65,'advanced_image_points':80})
        server.browser=self.fake
    async def asyncTearDown(self):
        server.DATA=self.old_data;server.browser=self.old_browser;self.temp.cleanup()
    async def test_draft_does_not_submit(self):
        j=await server.fengtu_create_job('test')
        self.assertEqual(j['state'],'draft')
        self.assertEqual(j['quoted_points'],2)
        self.assertEqual(self.fake.api.await_count,1)
        self.assertEqual(server.load(j['id']),j)
    async def test_no_approval(self):
        j=await server.fengtu_create_job('test')
        with self.assertRaises(ValueError): await server.fengtu_submit_job(j['id'],False,2)
        self.assertEqual(server.load(j['id'])['state'],'draft')
    async def test_budget(self):
        j=await server.fengtu_create_job('test')
        with self.assertRaises(ValueError): await server.fengtu_submit_job(j['id'],True,1)
        self.assertEqual(server.load(j['id'])['state'],'draft')
    async def test_no_duplicate(self):
        j=await server.fengtu_create_job('test');j['state']='uncertain';server.save(j)
        count=self.fake.api.await_count
        out=await server.fengtu_submit_job(j['id'],True,100)
        self.assertIn('No resubmission',out['message'])
        self.assertEqual(self.fake.api.await_count,count)
    async def test_upload_approval(self):
        f=Path(self.temp.name)/'ref.txt';f.write_text('hello')
        j=await server.fengtu_create_job('test',files=[str(f)])
        with self.assertRaises(ValueError): await server.fengtu_submit_job(j['id'],True,2)
    async def test_file_changed(self):
        f=Path(self.temp.name)/'ref.txt';f.write_text('hello')
        j=await server.fengtu_create_job('test',files=[str(f)]);f.write_text('changed')
        with self.assertRaises(ValueError): await server.fengtu_submit_job(j['id'],True,2,True)
    async def test_bad_parent(self):
        j=await server.fengtu_create_job('test')
        with self.assertRaises(ValueError): await server.fengtu_create_job('image',parent_job_id=j['id'])
    async def test_price_validation(self):
        for n in [float('nan'),float('inf'),-1,True,None]:
            with self.assertRaises(ValueError): server.cost({'text_points':n},'text_plan')
    async def test_path_traversal(self):
        with self.assertRaises(ValueError): server.load('../test')
    async def test_redaction(self):
        self.assertEqual(server.clean({'token':'secret','nested':{'password':'x'},'author_avatar':'data:foo'}),{'nested':{}})

async def live():
    params=StdioServerParameters(command=sys.executable,args=[str(Path(__file__).with_name('server.py'))],env={**os.environ,'PYTHONIOENCODING':'utf-8'})
    async with stdio_client(params) as (read,write):
        async with ClientSession(read,write) as client:
            await client.initialize()
            tools=await client.list_tools()
            print(json.dumps({'tools':[t.name for t in tools.tools]},ensure_ascii=False))
            for name,args in [('fengtu_status',{}),('fengtu_pricing',{}),('fengtu_video_capabilities',{}),('fengtu_skills',{'query':'industrial'}),('fengtu_showcases',{'page':1})]:
                result=await client.call_tool(name,args)
                if result.isError: raise RuntimeError(str(result.content))
                texts=[c.text for c in result.content if hasattr(c,'text')]
                data=json.loads(texts[0]) if texts else {}
                if name=='fengtu_skills': data={'matching_skills':len(data.get('items',[]))}
                if name=='fengtu_showcases': data={'total':data.get('total'),'returned':len(data.get('items',[]))}
                print(json.dumps({'tool':name,'result':data},ensure_ascii=False))

if __name__=='__main__':
    if '--live' in sys.argv: asyncio.run(live())
    else: unittest.main()
