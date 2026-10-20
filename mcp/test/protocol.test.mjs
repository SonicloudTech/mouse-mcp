import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
test('real SDK protocol: every tool, error schemas, concurrency',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'umouse-protocol-'));
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve(process.env.UMOUSE_MCP_ENTRY || 'mcp/dist/index.js')],cwd:os.tmpdir(),env:{...process.env,UMSDK_DATA_DIR:dir,UMSDK_SPEECH_AUTO:'0',UMSDK_INJECT_KEYBOARD:'0',UMSDK_TEST_CAPS:'{"*":{"mouse_control":"supported","keyboard_control":"unsupported"}}',UMSDK_RAW_DIAG:'1'},stderr:'pipe'});
  const client=new Client({name:'audit-protocol',version:'1'});
  const id='__audit_nonexistent_device__';
  const cases={
    umouse_status:{},umouse_list_devices:{},umouse_get_events:{},umouse_wait_events:{timeout_ms:100,types:['audit-never']},
    umouse_set_dpi:{level:42,device_id:id},umouse_meeting_create:{device_id:id},umouse_meeting_destroy:{device_id:id},umouse_meeting_pause:{device_id:id},umouse_meeting_resume:{device_id:id},
    umouse_set_channel_pref:{pref:'AUTO',device_id:id},umouse_set_audio_source:{device_id:id},
    umouse_cursor_move:{dx:1,dy:0,device_id:id},umouse_cursor_click:{button:'left',device_id:id},umouse_cursor_scroll:{amount:1,device_id:id},umouse_button:{action:'press',button:'left',device_id:id},
    umouse_cursor_drag:{dx:1,dy:0,device_id:id},umouse_key_tap:{keys:[4],mods:[],device_id:id},
    umouse_cursor_move_to:{x:-99999,y:-99999,device_id:id},umouse_cursor_click_at:{x:-99999,y:-99999,device_id:id},umouse_key_release_all:{device_id:id},
    umouse_audio_record:{action:'status'},umouse_reconfigure:{usb:null,ble:null},
    umouse_voice_inbox:{},umouse_wait_voice:{timeout_ms:100},umouse_ack_voice:{event_id:'00000000-0000-4000-8000-000000000000'},umouse_get_capabilities:{},umouse_voice_status:{},umouse_voice_start:{device_id:id},umouse_voice_wait:{session_id:'00000000-0000-4000-8000-000000000000',wait_ms:100},umouse_voice_finish:{session_id:'00000000-0000-4000-8000-000000000000'},umouse_voice_cancel:{session_id:'00000000-0000-4000-8000-000000000000'},umouse_write_raw:{hex:'0a03f0000000000000000000',device_id:id}
  };
  let stderr='';transport.stderr?.on('data',b=>stderr+=b);
  try{
    await client.connect(transport);
    const {tools}=await client.listTools();
    // 默认 23 个：22 静态（含 v2 语音/能力工具）+ 1 raw 诊断（UMSDK_RAW_DIAG=1）。注入族隐藏是正确行为：无在线设备 → 无 mouse_control 声明（unknown 即禁止，G01）。
    // 旧的非 win32 21 是早期 move_to/click_at 平台门控的残留——注册现无平台差异。
    assert.equal(tools.length,23);
    for(const tool of tools){
      assert.ok(cases[tool.name]);
      const r=await client.callTool({name:tool.name,arguments:cases[tool.name]});
      assert.ok(r.content?.length,tool.name);
      if(!['umouse_status','umouse_list_devices','umouse_get_events','umouse_wait_events','umouse_set_audio_source','umouse_audio_record','umouse_reconfigure','umouse_voice_inbox','umouse_wait_voice','umouse_get_capabilities','umouse_voice_start','umouse_voice_status'].includes(tool.name)) assert.equal(r.isError,true,tool.name);
      console.log('TOOL PASS',tool.name,r.isError?'expected error':'response');
    }
    for(const [name,args] of [
      ['umouse_set_dpi',{level:256}],['umouse_write_raw',{hex:'a'}],['umouse_voice_start',{end_mode:'bogus'}],
      ['umouse_reconfigure',{usb:{vid:65536,pid:1,iface:1}}],['umouse_cursor_move',{dx:1.5,dy:0}],
      ['umouse_audio_record',{action:'start',device_id:id}]
    ]) assert.equal((await client.callTool({name,arguments:args})).isError,true,`${name} invalid input`);
    const [waiting,status]=await Promise.all([
      client.callTool({name:'umouse_wait_events',arguments:{timeout_ms:150,types:['audit-never']}}),
      client.callTool({name:'umouse_status',arguments:{}})
    ]);
    assert.equal(JSON.parse(waiting.content[0].text).timedOut,true);
    assert.equal(JSON.parse(status.content[0].text).sdkStarted,true);
  }finally{await client.close();fs.rmSync(dir,{recursive:true,force:true});}
});
