// Offline ABI fixture only. No USB, network, microphone, helper or OS input APIs.
#include "umouse_sdk.h"
#include <cstdint>
#include <string>
#include <vector>
#include <thread>
#include <mutex>
#include <chrono>
#define API extern "C" __declspec(dllexport)
namespace {
std::vector<std::string> trace;
std::string traceText,source;
int mode=0;
um_on_connected onConnected=nullptr; um_on_disconnected onDisconnected=nullptr;
um_on_message onMessage=nullptr; um_on_audio onAudio=nullptr; um_on_raw_frame onRaw=nullptr;
void log(const char* s) { trace.emplace_back(s); }
void message(const char* s) { if(onMessage) onMessage("fake-mouse",s); }
}
API void fixture_reset(int value) { mode=value; trace.clear(); source.clear(); }
API const char* fixture_trace() { traceText.clear(); for(auto& s:trace) traceText+=s+"\n"; return traceText.c_str(); }
API void fixture_message(const char* json) { message(json); }
API void fixture_audio(int invalid) { uint8_t pcm[4]{1,0,2,0}; if(onAudio) onAudio("fake-mouse",invalid?nullptr:pcm,4); }
void um_sdk_init(int) { log("mouse.init"); if(onConnected) onConnected("fake-mouse",0); }
void um_sdk_close() { log("mouse.close"); }
const char* um_sdk_version() { return "fixture-only-0.4.24"; }
void um_enable_crash_report(int) {}
int um_set_work_mode(int) { return 1; }
int um_set_device_limit(const char*,int) { return 1; }
int um_set_usb_config(const char*,const um_usb_config*) { return 1; }
int um_set_ble_config(const char*,const um_ble_config*) { return 1; }
int um_set_channel_pref(int) { return 1; }
int um_set_channel_pref_for(const char*,int) { return 1; }
int um_set_audio_source(const char* id) { source=id?id:""; return 1; }
const char* um_get_audio_source() { return source.c_str(); }
void um_register_connected(um_on_connected cb) { onConnected=cb; log(cb?"mouse.connected.attach":"mouse.connected.detach"); }
void um_register_disconnected(um_on_disconnected cb) { onDisconnected=cb; }
void um_register_message(um_on_message cb) { onMessage=cb; log(cb?"mouse.message.attach":"mouse.message.detach"); }
void um_register_audio(um_on_audio cb) { onAudio=cb; }
void um_register_raw_frame(um_on_raw_frame cb) { onRaw=cb; }
int um_get_device_count() { return 1; }
const char* um_get_device_id(int i) { return i==0?"fake-mouse":nullptr; }
int um_get_connection_mode(const char*) { return 0; }
int um_write_raw(const char*,const uint8_t* data,int n) { if(n==3&&data[0]==10&&data[1]==3&&data[2]==162) log("mouse.a2"); return 1; }
int um_set_dpi(const char*,int) { return 1; }
int um_meeting_create(const char*) { log("mouse.meeting.create"); message("{\"type\":\"meetingCreated\"}"); return 1; }
int um_meeting_destroy(const char*) {
    log("mouse.meeting.destroy");
    if(mode==1) return 1; // No ACK or boundary: transport success is insufficient.
    message("{\"type\":\"meetingDestroyed\",\"origin\":\"device-frame\"}");
    message(mode==2?"{\"type\":\"audioSegmentComplete\",\"reason\":\"key-up\",\"segment\":1}":
                    "{\"type\":\"audioSegmentComplete\",\"reason\":\"meeting-destroyed\",\"segment\":1}");
    return 1;
}
int um_meeting_pause(const char*) { return 1; }
int um_meeting_resume(const char*) { return 1; }
int um_inject_mouse(const char*,int,int,int,int) { log("mouse.inject.FAKE"); return 1; }
int um_inject_keyboard(const char*,int,const uint8_t*,int) { log("keyboard.inject.FAKE"); return 1; }

// Independent ABI layout matching the public ASRTools C callback contract.
struct Callbacks { size_t size; void* user; void (*state)(void*,int); void (*preview)(void*,const char*);
    void (*finalText)(void*,const char*); void (*raw)(void*,const char*); void (*error)(void*,int,const char*); void (*warning)(void*,int,const char*); };
struct Asr { Callbacks cb{}; std::mutex mutex; std::thread worker; };
API const char* atr_version() { return "fixture-only-0.2.2"; }
API void* atr_create(const Callbacks* cb,const char*) {
    log("asr.create"); if(cb->size!=sizeof(Callbacks)) return nullptr; auto p=new Asr; p->cb=*cb; return p;
}
API int atr_set_engine_config(void*,const char*) { log("asr.configure"); return mode==3?9:0; }
API int atr_start(void* ctx,const char*) {
    log("asr.start"); auto p=static_cast<Asr*>(ctx); if(p->cb.state) p->cb.state(p->cb.user,2);
    p->worker=std::thread([p]{ std::this_thread::sleep_for(std::chrono::milliseconds(20));
        std::lock_guard<std::mutex> lock(p->mutex); if(p->cb.preview) p->cb.preview(p->cb.user,"late-preview"); });
    return 0;
}
API int atr_append_audio(void* ctx,const uint8_t*,int) { log("asr.append"); auto p=static_cast<Asr*>(ctx); if(p->cb.preview) p->cb.preview(p->cb.user,"你好"); return 0; }
API int atr_stop(void* ctx) { log("asr.finish"); auto p=static_cast<Asr*>(ctx); if(p->cb.finalText) p->cb.finalText(p->cb.user,"你好，测试"); if(p->cb.state) p->cb.state(p->cb.user,4); return 0; }
API int atr_cancel(void*) { log("asr.cancel"); return 0; }
API int atr_set_callbacks(void* ctx,const Callbacks* cb) { log("asr.detach"); auto p=static_cast<Asr*>(ctx); std::lock_guard<std::mutex> lock(p->mutex); p->cb=*cb; return 0; }
API void atr_destroy(void* ctx) { log("asr.destroy"); auto p=static_cast<Asr*>(ctx); if(p->worker.joinable()) p->worker.join(); delete p; log("asr.joined"); }
API int atr_state(void*) { return 2; }

API const char* typer_version() { return "fixture-only-1.1.2"; }
API void* typer_create(const void*) { log("typer.create"); return new int(1); }
API void typer_destroy(void* p) { log("typer.destroy"); delete static_cast<int*>(p); }
API int typer_type_text(void*,const char*) { log("typer.text.FAKE"); return 0; }

using ScreenEvent=void(*)(void*,const char*,const uint8_t*,int);
struct Screen { ScreenEvent cb=nullptr; void* user=nullptr; };
API const char* sct_version() { return "fixture-only-1.2.2"; }
API void* sct_create() { log("screen.create"); return new Screen; }
API int sct_set_event_callback(void* ctx,ScreenEvent cb,void* user) { auto p=static_cast<Screen*>(ctx); p->cb=cb;p->user=user; log(cb?"screen.attach":"screen.detach");return 0; }
API int sct_set_helper_path(void*,const char*) { log("screen.helper.path.only");return 0; }
API int sct_connect_async(void* ctx,int) { log("screen.connect.FAKE"); auto p=static_cast<Screen*>(ctx); if(p->cb)p->cb(p->user,"{\"event\":\"connected\"}",nullptr,0);return 0; }
API int sct_start_capture(void* ctx,const char*) { log("screen.capture.FAKE"); auto p=static_cast<Screen*>(ctx); uint8_t b[]{1,2,3}; if(p->cb)p->cb(p->user,"{\"event\":\"image\"}",b,3); return 0; }
API int sct_cancel_capture(void*) { log("screen.cancel");return 0; }
API int sct_shutdown(void*,const char*) { log("screen.shutdown");return 0; }
#ifndef UMCP_NO_SCREEN_WAIT
API void sct_destroy_wait(void* p) { log("screen.destroy_wait");delete static_cast<Screen*>(p); }
#endif
API void sct_destroy(void* p) { log("screen.destroy.UNSAFE");delete static_cast<Screen*>(p); }
