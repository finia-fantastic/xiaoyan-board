import { HoswingBrowser } from './browser.mjs';
import { Pipeline } from './pipeline.mjs';
import { id } from './core.mjs';
const jobId=id(process.argv[2]);
const api=new HoswingBrowser();
try {
  const result=await new Pipeline(api).run(jobId);
  console.error(JSON.stringify({jobId,status:result.status,error:result.error}));
  process.exitCode=result.status==='completed'?0:2;
}catch(e){console.error(e.message);process.exitCode=1;}
finally{await api.disconnect();}
