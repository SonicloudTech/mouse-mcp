import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const entry=path.resolve('mcp/scripts/install-agents.mjs');
test('installer preserves existing entries, rejects invalid shapes, removes only umouse',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'umouse-installer-'));
  const file=path.join(dir,'.agents','mcp.json');fs.mkdirSync(path.dirname(file));
  const run=(...args)=>spawnSync(process.execPath,[entry,...args],{cwd:dir,encoding:'utf8'});
  try{
    for(const shape of [[],null,{mcpServers:[]},{mcpServers:1}]){
      const original=JSON.stringify(shape);fs.writeFileSync(file,original);
      assert.notEqual(run('agents').status,0);assert.equal(fs.readFileSync(file,'utf8'),original);
    }
    fs.writeFileSync(file,'\uFEFF'+JSON.stringify({other:1,mcpServers:{existing:{command:'unchanged'}}}));
    assert.equal(run('agents').status,0);
    const result=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(result.other,1);assert.equal(result.mcpServers.existing.command,'unchanged');
    const before=fs.statSync(file).mtimeMs;
    assert.equal(run('agents').status,0);assert.equal(fs.statSync(file).mtimeMs,before);
    assert.equal(run('--remove','agents').status,0);
    assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{other:1,mcpServers:{existing:{command:'unchanged'}}});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
