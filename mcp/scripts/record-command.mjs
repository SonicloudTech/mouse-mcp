// Offline regression/maintenance command recorder. Does not open MCP or hardware.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
const [output,command,...args]=process.argv.slice(2);
if(!output||!command)throw new Error('Usage: record-command.mjs NEW-LOG.jsonl EXECUTABLE [ARGUMENTS]');
const fd=fs.openSync(output,'wx');const began=performance.now();
const log=(stage,fields={})=>fs.writeSync(fd,JSON.stringify({utc:new Date().toISOString(),elapsedMs:performance.now()-began,stage,...fields})+'\n');
log('command.start',{command,args});
const child=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
for(const [name,stream] of [['stdout',child.stdout],['stderr',child.stderr]]){let text='';stream.setEncoding('utf8');stream.on('data',part=>{text+=part;let i;while((i=text.indexOf('\n'))>=0){log(name,{line:text.slice(0,i).replace(/\r$/,'')});text=text.slice(i+1);}});stream.on('end',()=>{if(text)log(name,{line:text});});}
child.on('error',error=>log('command.error',{message:error.message}));
child.on('close',(code,signal)=>{log('command.end',{code,signal});fs.closeSync(fd);console.log(JSON.stringify({output,code,elapsedMs:performance.now()-began}));process.exitCode=code??1;});
