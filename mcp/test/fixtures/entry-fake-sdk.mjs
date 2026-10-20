// Test-only preload: never loads a native device SDK; isolates its arbitration pipe.
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { SdkLease } from '../../dist/sdk-lease.js';
const pipe=process.env.UMOUSE_TEST_PIPE;
if(!pipe?.startsWith('\\\\.\\pipe\\umouse-test-')) throw new Error('Missing isolated test pipe');
const acquire=SdkLease.prototype.tryAcquire;
SdkLease.prototype.tryAcquire=function(){this.pipe=pipe;return acquire.call(this);};
const require=createRequire(import.meta.url);
const binding=require('../../../doc/umouse-sdk.js');
binding.UMouseSdk=class extends EventEmitter {
  running=false;
  version(){return 'fake-entry-no-hardware';} isStarted(){return this.running;}
  setWorkMode(){return 1;} setDeviceLimit(){return 1;}
  enableCrashReport(){} start(){this.running=true;} stop(){this.running=false;}
  unregisterCallbacks(){} deviceList(){return [];} audioSource(){return '';}
  injectMouse(){return 1;} injectKeyboard(){return 1;} writeRaw(){return 1;}
};
