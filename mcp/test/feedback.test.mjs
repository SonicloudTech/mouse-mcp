import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {InjectController}=await import(process.env.AUDIT_INJECT_MODULE
  ? pathToFileURL(process.env.AUDIT_INJECT_MODULE).href : '../dist/inject.js');

function delayedCursor(delay=150) {
  let pos={x:500,y:400};
  const pending=[],frames=[];
  const reader=()=>{
    while(pending.length && pending[0].at<=performance.now()) {
      const {dx,dy}=pending.shift(); pos={x:pos.x+dx,y:pos.y+dy};
    }
    return {...pos};
  };
  return {frames,reader,sender:{keyboard:()=>1,mouse:(buttons,dx,dy)=>{
    reader();
    frames.push({buttons,dx,dy,pending:pending.length,pos:{...pos}});
    if(dx||dy) pending.push({at:performance.now()+delay,dx,dy});
    return 1;
  }}};
}
test('delayed feedback: converges without more than one outstanding displacement',async()=>{
  const sim=delayedCursor();
  const c=new InjectController(sim.sender,{frameMs:1,clickMs:1,feedbackTimeoutMs:600},sim.reader);
  try {
    const result=await c.moveTo(650,470);
    assert.equal(result.ok,true);
    assert.ok(Math.abs(result.final.x-650)<=3 && Math.abs(result.final.y-470)<=3);
    assert.ok(sim.frames.every(f=>f.pending===0),'must observe previous move before next write');
  } finally {c.dispose();}
});
test('missing feedback: sends only one displacement and warns of late execution',async()=>{
  const sim=delayedCursor(10000);
  const c=new InjectController(sim.sender,{frameMs:1,clickMs:1,feedbackTimeoutMs:160},sim.reader);
  try {
    const result=await c.moveTo(650,470);
    assert.equal(result.ok,false);
    assert.equal(result.sent,1);
    assert.equal(sim.frames.length,1);
    assert.match(result.note,/延迟执行/);
  } finally {c.dispose();}
});
test('clickAt waits for delayed OS position before pressing',async()=>{
  const sim=delayedCursor();
  const c=new InjectController(sim.sender,{frameMs:1,clickMs:1,feedbackTimeoutMs:600},sim.reader);
  try {
    const result=await c.clickAt(650,470,'left',1);
    assert.equal(result.ok,true);
    assert.equal(result.frames,sim.frames.length,'total frames include positioning and click');
    const down=sim.frames.find(f=>f.buttons===1);
    assert.ok(down);
    assert.ok(Math.abs(down.pos.x-650)<=3 && Math.abs(down.pos.y-470)<=3);
    assert.equal(c.state().heldButtons,0);
  } finally {c.dispose();}
});
test('clickAt never presses after missing feedback',async()=>{
  const sim=delayedCursor(10000);
  const c=new InjectController(sim.sender,{frameMs:1,clickMs:1,feedbackTimeoutMs:160},sim.reader);
  try {
    const result=await c.clickAt(650,470,'left',1);
    assert.equal(result.ok,false);
    assert.equal(result.click,undefined);
    assert.ok(sim.frames.every(f=>f.buttons===0));
  } finally {c.dispose();}
});
test('suspend interrupts feedback waiting and never sends another displacement',async()=>{
  let started;
  const firstWrite=new Promise(resolve=>{started=resolve;});
  const frames=[];
  const c=new InjectController({keyboard:()=>1,mouse:(...args)=>{frames.push(args);started();return 1;}},
    {frameMs:1,clickMs:1},()=>({x:0,y:0}));
  let timer;
  try {
    const rejected=assert.rejects(c.moveTo(200,100),/注入已暂停/);
    await firstWrite;
    await Promise.race([c.suspend(),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('suspend waited for feedback timeout')),1000);
    })]);
    await rejected;
    assert.equal(frames.filter(f=>f[1]||f[2]).length,1);
  } finally {clearTimeout(timer);c.dispose();}
});
