import json
import sys
from pathlib import Path
from datetime import datetime

root=Path(__file__).resolve().parent
entry={'type':'stdio','command':sys.executable,'args':[str(root/'server.py')],'env':{'PYTHONIOENCODING':'utf-8','FENGTU_CDP_URL':'http://127.0.0.1:9333'}}
(root/'mcp-config.json').write_text(json.dumps({'mcpServers':{'fengtu':entry}},indent=2),encoding='utf-8')
config=Path.home()/'.claude.json'
original=config.read_bytes()
data=json.loads(original)
servers=data.setdefault('mcpServers',{})
if 'fengtu' in servers and servers['fengtu']!=entry:
    raise SystemExit('Existing fengtu differs; no overwrite performed')
if servers.get('fengtu')!=entry:
    backup=config.with_name(config.name+'.before-fengtu-'+datetime.now().strftime('%Y%m%d-%H%M%S'))
    backup.write_bytes(original)
    servers['fengtu']=entry
    if config.read_bytes()!=original: raise SystemExit('Configuration changed concurrently; stopped')
    temp=config.with_suffix('.fengtu.tmp')
    temp.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    temp.replace(config)
readback=json.loads(config.read_text(encoding='utf-8'))
assert readback['mcpServers']['fengtu']==entry
old=json.loads(original);current=dict(readback);current['mcpServers']=dict(current['mcpServers']);current['mcpServers'].pop('fengtu',None)
old.setdefault('mcpServers',{}).pop('fengtu',None)
assert current==old,'Unexpected unrelated configuration change'
print(json.dumps({'installed':'fengtu','config':str(config),'preserved_other_servers':len(current['mcpServers'])},ensure_ascii=False))
