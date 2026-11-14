import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HoswingBrowser } from '../src/browser.mjs';
import { DEFAULT_PROJECT } from '../src/core.mjs';
const api=new HoswingBrowser();
try {
 try {await api.connect();}
 catch {
  const candidates=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
  let executable;for(const c of candidates){try{await fs.access(c);executable=c;break;}catch{}}
  if(!executable)throw Error('找不到 Microsoft Edge。');
  const child=spawn(executable,['--remote-debugging-port=9333','--user-data-dir='+join(dirname(dirname(fileURLToPath(import.meta.url))),'browser-profile'),'--no-first-run','https://www.hoswing.cn/idmaster'],{detached:true,stdio:'ignore',windowsHide:true});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
  for(let n=0;n<10;n++){try{await api.connect();break;}catch(e){if(n===9)throw e;await new Promise(r=>setTimeout(r,700));}}
 }
 console.log(JSON.stringify(await api.openLogin(DEFAULT_PROJECT),null,2));
} catch(e){console.error(e.message);process.exitCode=1;}
finally {await api.disconnect();}
