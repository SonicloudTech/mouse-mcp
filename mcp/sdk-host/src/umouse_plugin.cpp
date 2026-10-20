#include "plugin_support.hpp"
#include "umouse_sdk.h"
#include "window_guard.hpp"
#include "input_sequence.hpp"
#include "diagnostics.hpp"
#include "raw_button_feedback.hpp"
#include "input_quarantine.hpp"
#include <chrono>
#include <condition_variable>
#include <set>
#include <thread>

using namespace umcp;
namespace {
// Software key sensor for diagnostics and recovery. GetAsyncKeyState observes
// the same Windows input state that hardware reports feed, so it sees both
// physical and injected buttons. Report-only; it never gates admission.
struct ButtonScan { Json::Object report; bool mouseDown=false,keysDown=false,anyDown=false; };
ButtonScan scanButtons() {
    static const std::pair<const char*,int> watched[]{{"left",VK_LBUTTON},{"right",VK_RBUTTON},{"middle",VK_MBUTTON},
        {"x1",VK_XBUTTON1},{"x2",VK_XBUTTON2},{"shift",VK_SHIFT},{"control",VK_CONTROL},{"menu",VK_MENU},
        {"leftWindows",VK_LWIN},{"rightWindows",VK_RWIN}};
    ButtonScan scan;
    for(auto& [name,vk]:watched) {
        const bool down=(GetAsyncKeyState(vk)&0x8000)!=0;
        scan.report[name]=down;scan.anyDown|=down;
        if(down) { if(vk>=VK_LBUTTON&&vk<=VK_XBUTTON2)scan.mouseDown=true; else scan.keysDown=true; }
    }
    return scan;
}
struct Mouse final: Adapter {
    DiagnosticLog trace{"umouse"};
#define SDK(name) decltype(&name) f_##name=library.symbol<decltype(&name)>(#name)
    SDK(um_sdk_init); SDK(um_sdk_close); SDK(um_sdk_version); SDK(um_enable_crash_report);
    SDK(um_set_work_mode); SDK(um_set_device_limit); SDK(um_set_usb_config); SDK(um_set_ble_config);
    SDK(um_set_channel_pref); SDK(um_set_channel_pref_for); SDK(um_set_audio_source); SDK(um_get_audio_source);
    SDK(um_register_connected); SDK(um_register_disconnected); SDK(um_register_message); SDK(um_register_audio); SDK(um_register_raw_frame);
    SDK(um_get_device_count); SDK(um_get_device_id); SDK(um_get_connection_mode);
    SDK(um_write_raw); SDK(um_set_dpi); SDK(um_meeting_create); SDK(um_meeting_destroy); SDK(um_meeting_pause); SDK(um_meeting_resume);
    SDK(um_inject_mouse); SDK(um_inject_keyboard);
#undef SDK
    using IoCallback=void(*)(const char*,const uint8_t*,int,int);
    using RegisterIo=void(*)(IoCallback);
    RegisterIo traceRegister=library.optionalSymbol<RegisterIo>("um_register_input_io_trace");
    static void ioTrace(const char* stage,const uint8_t* bytes,int count,int result) noexcept {
        try{if(active)active->trace.record(stage,{{"hex",traceHex(bytes,count)},{"bytes",count},{"result",result}});}catch(...){}
    }
    static Mouse* active;
    bool started=false;
    std::mutex stateMutex;
    std::set<std::string> pendingClose,meetingDrain,physicalDrain,physicalHeld;
    std::map<std::string,int> heldButtons;
    // Transport success cannot erase a release that lacked passive confirmation.
    std::set<std::string> buttonReleaseUnconfirmed;
    std::set<std::string> heldKeys;
    std::map<std::string,int> generations,heldGenerations;
    // Per-device positioning gain curve, persisted across actions. std::map
    // nodes are stable under insert, and one device runs one action at a time
    // under the hardware-control arbiter, so handing the element pointer into
    // the action is safe; the gain only scales bounded correction frames.
    std::map<std::string,PositioningMemory> positioning;
    std::set<std::string> online;
    Json config;
    int feedbackVid=0xABC9,feedbackPid=0xCA89;
    std::filesystem::path runMarker;
    InputQuarantine inputQuarantine;
    Mouse(const umcp_host_v1* h,const Json& c):Adapter(h,c),config(c) {}
    static void connected(const char* id,int mode) { callbackBoundary([&]{ if(active) {
        std::string device=id?id:""; int generation;
        { std::lock_guard<std::mutex> lock(active->stateMutex); generation=++active->generations[device]; active->online.insert(device); }
        active->emit(Json::Object{{"type","connected"},{"deviceId",device},{"mode",mode},{"generation",generation}});
    } }); }
    static void disconnected(const char* id,int mode) { callbackBoundary([&]{ if(active) {
        std::string device=id?id:""; {std::lock_guard<std::mutex> lock(active->stateMutex); active->online.erase(device);}
        active->emit(Json::Object{{"type","disconnected"},{"deviceId",device},{"mode",mode}});
    } }); }
    static void message(const char* id,const char* raw) {
        auto p=active; if(!p) return;
        try {
            auto j=Json::parse(raw?raw:"{}"); auto type=j.text("type"); std::string device=id?id:"";
            {
                std::lock_guard<std::mutex> lock(p->stateMutex);
                if(type=="meetingDestroyed" && j.text("origin")=="device-frame") p->pendingClose.erase(device);
                if(type=="audioSegmentComplete") {
                    auto reason=j.text("reason");
                    if(reason=="meeting-destroyed"||reason=="meeting-destroyed-incomplete") p->meetingDrain.erase(device);
                    if((reason=="key-up"||reason=="key-up-incomplete")&&!p->physicalHeld.count(device)) p->physicalDrain.erase(device);
                }
                if(type=="keyEvent" && j.text("key")=="speech") {
                    if(j.text("action")=="down") { p->physicalHeld.insert(device); p->physicalDrain.insert(device); }
                    if(j.text("action")=="up") p->physicalHeld.erase(device);
                }
            }
            p->emit(Json::Object{{"type","message"},{"deviceId",device},{"message",std::move(j)}});
        } catch(...) { callbackBoundary([&]{ p->emit(Json::Object{{"type","protocolWarning"},{"code","invalid_device_message"}}); }); }
    }
    static void audio(const char* id,const uint8_t* pcm,int n) { callbackBoundary([&]{ if(active && n>0) {
        if(n>65536||!pcm) {active->emit(Json::Object{{"type","streamIncomplete"},{"deviceId",id?id:""}});return;}
        active->emit(Json::Object{{"type","audio"},{"deviceId",id?id:""}},pcm,n);
    } }); }
    static void raw(const char* id,const uint8_t* data,int n,int conn) { callbackBoundary([&]{ if(active && n>0 && n<=65536) active->emit(Json::Object{{"type","rawFrame"},{"deviceId",id?id:""},{"conn",conn}},data,n); }); }
    std::string target(const Json& a) {
        auto id=a.text("deviceId");
        if(id.empty()) {
            if(f_um_get_device_count()!=1) throw std::runtime_error("device_id_required");
            const char* p=f_um_get_device_id(0); id=p?p:"";
        }
        if(id.empty()) throw std::runtime_error("device_offline"); return id;
    }
    Json devices() {
        Json::Array a;
        for(int i=0,n=f_um_get_device_count();i<n && i<8;i++) {
            auto p=f_um_get_device_id(i); std::string id=p?p:"";
            if(!id.empty()) { int generation=0; {std::lock_guard<std::mutex> lock(stateMutex);generation=generations[id];}
                a.push_back(Json::Object{{"id",id},{"mode",f_um_get_connection_mode(id.c_str())},{"generation",generation}}); }
        }
        return a;
    }
    Json call(const std::string& method,const Json& a) {
        if(!a.object()) throw std::runtime_error("args_object_required");
        if(method=="status") return Json::Object{{"version",f_um_sdk_version()},{"started",started},{"devices",started?devices():Json(Json::Array{})},{"inputQuarantine",inputQuarantine.status()}};
        if(method=="start") {
            if(started) return Json::Object{{"started",true},{"inputQuarantine",inputQuarantine.status()}};
            if(active && active!=this) throw std::runtime_error("sdk_instance_exists");
            auto stateDir=std::filesystem::path(wide(config.text("runtimeStateDir")));
            if(!stateDir.is_absolute()) throw std::runtime_error("runtime_state_dir_required");
            std::filesystem::create_directories(stateDir);
            runMarker=stateDir/L"sdk-running.json";
            // A previous crash/forced stop is not evidence of hardware cleanup.
            if(std::filesystem::exists(runMarker)) throw std::runtime_error("previous_worker_exit_unclean");
            inputQuarantine.load(stateDir);
            if(!f_um_set_work_mode(UM_MODE_FULL) || !f_um_set_device_limit(nullptr,a.number("deviceLimit",4,1,8))) throw std::runtime_error("sdk_config_rejected");
            if(a.has("usb")) {
                auto& u=a.get("usb"); um_usb_config c{};
                c.vid=static_cast<unsigned short>(u.number("vid",0,0,65535)); c.pid=static_cast<unsigned short>(u.number("pid",0,0,65535));
                c.iface=u.number("iface",1,-1,INT32_MAX); c.report_id=static_cast<unsigned char>(u.number("reportId",0,0,255));
                if(!f_um_set_usb_config(nullptr,&c)) throw std::runtime_error("usb_config_rejected");
                feedbackVid=c.vid?c.vid:0xABC9;feedbackPid=c.pid?c.pid:0xCA89;
            }
            if(a.has("ble")) {
                auto& b=a.get("ble"); auto name=b.text("name"),mac=b.text("macPrefix"),service=b.text("service"),characteristic=b.text("characteristic");
                um_ble_config c{name.c_str(),mac.c_str(),service.c_str(),characteristic.c_str()};
                if(!f_um_set_ble_config(nullptr,&c)) throw std::runtime_error("ble_config_rejected");
            }
            f_um_enable_crash_report(0); // Host owns crash policy; no process-global handler chaining.
            HANDLE marker=CreateFileW(runMarker.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);
            if(marker==INVALID_HANDLE_VALUE) throw std::runtime_error("runtime_journal_failed");
            const std::string data=Json(Json::Object{{"schemaVersion",1},{"pid",static_cast<int>(GetCurrentProcessId())},{"cleanup","unknown"}}).dump();
            DWORD wrote=0; bool journalOk=WriteFile(marker,data.data(),static_cast<DWORD>(data.size()),&wrote,nullptr)&&wrote==data.size()&&FlushFileBuffers(marker);
            CloseHandle(marker); if(!journalOk) throw std::runtime_error("runtime_journal_failed");
            active=this;
            if(traceRegister && GetEnvironmentVariableW(L"UMCP_TRACE_DIR",nullptr,0)>1)traceRegister(ioTrace);
            trace.record("sdk.start",{{"version",f_um_sdk_version()},{"usbTraceAvailable",traceRegister!=nullptr}});
            f_um_register_connected(connected); f_um_register_disconnected(disconnected); f_um_register_message(message);
            f_um_register_audio(audio); f_um_register_raw_frame(config.boolean("rawFrameEvents")?raw:nullptr);
            f_um_sdk_init(a.number("debug",0,0,2)); started=true;
            return Json::Object{{"started",true},{"version",f_um_sdk_version()},{"devices",devices()},{"inputQuarantine",inputQuarantine.status()}};
        }
        if(!started) throw std::runtime_error("sdk_not_started");
        if(method=="devices") return devices();
        if(method=="input.status") {
            PhysicalCoordinates coordinates;POINT p{};
            if(!GetCursorPos(&p))throw std::runtime_error("cursor_unavailable");
            auto scan=scanButtons();
            return Json::Object{{"cursor",Json::Object{{"x",static_cast<int>(p.x)},{"y",static_cast<int>(p.y)}}},
                {"foreground",observeForegroundWindow()},{"buttons",scan.report},{"anyButtonDown",scan.anyDown}};
        }
        if(method=="input.cleanup") {
            // Recovery-only: scan, one bounded release attempt, honest verdict.
            // A physically held key keeps anyDown true; that is a fact to report,
            // never a reason to claim release or clear the journal.
            auto before=scanButtons();
            bool sentMouse=false,sentKeyboard=false;
            if(before.anyDown&&config.boolean("allowHardwareInput")) {
                const auto online=devices();
                for(auto& d:online.items()) {
                    auto id=d.text("id");if(id.empty())continue;
                    const auto& caps=config.get("deviceCapabilities").get(id);
                    if(before.mouseDown&&caps.text("mouse_control","unknown")=="supported") {
                        trace.record("sdk.mouse.begin",{{"traceId","input.cleanup"},{"buttons",0},{"dx",0},{"dy",0},{"wheel",0}});
                        const int rc=f_um_inject_mouse(id.c_str(),0,0,0,0);
                        trace.record("sdk.mouse.end",{{"traceId","input.cleanup"},{"result",rc}});
                        sentMouse|=rc==1;
                    }
                    if(before.keysDown&&caps.text("keyboard_control","unknown")=="supported") {
                        trace.record("sdk.frame.begin",{{"traceId","input.cleanup"},{"frame",Json::Object{{"kind","keyboard"},{"modifiers",0},{"keys",Json::Array{}}}}});
                        const int rc=f_um_inject_keyboard(id.c_str(),0,nullptr,0);
                        trace.record("sdk.frame.end",{{"traceId","input.cleanup"},{"result",rc}});
                        sentKeyboard|=rc==1;
                    }
                }
                if(sentMouse||sentKeyboard)std::this_thread::sleep_for(std::chrono::milliseconds(80));
            }
            auto after=scanButtons();
            if(after.anyDown&&(sentMouse||sentKeyboard)) {
                std::this_thread::sleep_for(std::chrono::milliseconds(160));
                after=scanButtons();
            }
            bool journalCleared=false;
            if(!after.anyDown) {
                inputQuarantine.acknowledgeReleased();
                journalCleared=true;
            }
            trace.record("input.cleanup",{{"before",before.report},{"after",after.report},{"sentMouse",sentMouse},
                {"sentKeyboard",sentKeyboard},{"allReleased",!after.anyDown},{"journalCleared",journalCleared}});
            return Json::Object{{"before",before.report},{"after",after.report},{"sentMouse",sentMouse},{"sentKeyboard",sentKeyboard},
                {"allReleased",!after.anyDown},{"journalCleared",journalCleared}};
        }
        if(method=="audio.source") {
            if(a.has("deviceId")) { auto id=a.text("deviceId"); if(!f_um_set_audio_source(id.empty()?nullptr:id.c_str())) throw std::runtime_error("source_rejected"); }
            return Json::Object{{"source",f_um_get_audio_source()}};
        }
        auto id=target(a); int rc=0;
        if(method=="meeting.create") {
            { std::lock_guard<std::mutex> lock(stateMutex); if(!pendingClose.empty()||!physicalHeld.empty()||!meetingDrain.empty()||!physicalDrain.empty()) throw std::runtime_error("microphone_busy"); pendingClose.insert(id); meetingDrain.insert(id); }
            rc=f_um_meeting_create(id.c_str());
            if(rc!=1) { std::lock_guard<std::mutex> lock(stateMutex); pendingClose.erase(id); meetingDrain.erase(id); }
        } else if(method=="meeting.destroy") rc=f_um_meeting_destroy(id.c_str());
        else if(method=="meeting.pause") rc=f_um_meeting_pause(id.c_str());
        else if(method=="meeting.resume") rc=f_um_meeting_resume(id.c_str());
        else if(method=="sleep.reset") { const uint8_t bytes[]={0x0a,3,0xa2}; rc=f_um_write_raw(id.c_str(),bytes,3); }
        else if(method=="dpi") rc=f_um_set_dpi(id.c_str(),a.number("level",0,0,255));
        else if(method=="channel") rc=f_um_set_channel_pref_for(id.c_str(),a.number("preference",0,0,2));
        else if(method=="input.sequence") return sequence(id,a);
        else if(method=="mouse.action") return mouseAction(id,a);
        else throw std::runtime_error("method_not_supported");
        return Json::Object{{"sent",rc},{"confirmed",false}};
    }
    Json mouseAction(const std::string& id,const Json& a) {
        if(!config.boolean("allowHardwareInput")||config.get("deviceCapabilities").get(id).text("mouse_control","unknown")!="supported")throw std::runtime_error("hardware_input_disabled");
        int generation=a.number("deviceGeneration",0,1,INT32_MAX);
        auto current=[&]{std::lock_guard<std::mutex> lock(stateMutex);return online.size()==1&&online.count(id)&&generations[id]==generation;};
        if(!current())throw std::runtime_error("device_generation_changed");
        PositioningMemory* gainMemory; { std::lock_guard<std::mutex> lock(stateMutex);
            auto found=positioning.find(id);
            if(found==positioning.end()) {
                // Fresh device memory starts from this machine's pointer
                // settings, queried READ-ONLY (never writes user settings):
                // flat curve when acceleration is off, the measured ballistic
                // shape scaled by the speed-slider multiplier when on. The
                // seed only positions the first frames; online learning owns
                // the curve afterwards.
                int mouse[3]{6,10,1};unsigned int slider=10;
                SystemParametersInfoW(SPI_GETMOUSE,0,mouse,0);
                SystemParametersInfoW(SPI_GETMOUSESPEED,0,&slider,0);
                double seed[kGainBuckets];seedGainCurve(mouse[2]!=0,static_cast<int>(slider),seed);
                Json::Array curve;for(double v:seed)curve.push_back(v);
                trace.record("action.position.envSeed",{{"acceleration",mouse[2]!=0},{"slider",static_cast<int>(slider)},
                    {"multiplier",pointerSpeedMultiplier(static_cast<int>(slider))},{"curve",Json(curve)}});
                found=positioning.emplace(id,PositioningMemory::fromSeed(seed)).first;
            }
            gainMemory=&found->second; }
        PhysicalCoordinates coordinates;
        ActionPort port;
        std::unique_ptr<RawButtonFeedback> feedback;
        port.trace=[&](const char* stage,Json::Object fields){fields["traceId"]=a.text("traceId");fields["deviceId"]=id;fields["deviceGeneration"]=generation;trace.record(stage,std::move(fields));};
        // Window identity is receipt telemetry only; the OS owns focus and z-order.
        port.intentContext=[&]{return intentAnnotation(a);};
        port.observeForeground=[&]{return observeForegroundWindow();};
        port.observeTopmost=[&](Point point){return observeTopmostAt(point);};
        port.buttons=[&]{
            // The current SDK exposes no SN -> Windows collection mapping. Do not
            // guess when multiple SDK devices or non-USB transport are present.
            if(!current()||f_um_get_device_count()!=1||f_um_get_connection_mode(id.c_str())!=UM_CONN_USB)
                throw std::runtime_error("button_feedback_device_ambiguous");
            if(!feedback){
                feedback=std::make_unique<RawButtonFeedback>(feedbackVid,feedbackPid,port.trace);
                port.trace("action.feedback.bound",{{"devicePath",feedback->path()},{"identityScope","unique-usb-vid-pid-mouse-collection"}});
            }
            return feedback->snapshot();
        };
        port.doubleClickMs=static_cast<int>(GetDoubleClickTime());
        port.releasedBaseline=[&]{
            // Fresh passive baseline permits this explicit action. It does not
            // retroactively confirm the previous action or clear its evidence.
            heldButtons.erase(id);buttonReleaseUnconfirmed.erase(id);
            if(!heldKeys.count(id))heldGenerations.erase(id);
            port.trace("action.baseline.released",{});
        };
        port.now=[] {return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();};
        port.sleep=[](int ms){std::this_thread::sleep_for(std::chrono::milliseconds(ms));};
        port.current=current;port.cancelled=[&]{return cancelled();};
        port.cursor=[] {POINT p{};if(!GetCursorPos(&p))throw std::runtime_error("cursor_unavailable");return Point{p.x,p.y};};
        port.write=[&](int b,int dx,int dy,int wheel){
            if(!current())throw std::runtime_error("device_changed");
            if(b){heldButtons[id]=b;heldGenerations[id]=generation;}
            trace.record("sdk.mouse.begin",{{"traceId",a.text("traceId")},{"buttons",b},{"dx",dx},{"dy",dy},{"wheel",wheel}});
            int rc=f_um_inject_mouse(id.c_str(),b,dx,dy,wheel);
            trace.record("sdk.mouse.end",{{"traceId",a.text("traceId")},{"result",rc}});
            return rc; // Mouse cleanup is discharged only by the final observed receipt.
        };
        trace.record("input.journal.begin",{{"traceId",a.text("traceId")},{"scope","mouse"},{"movementOnly",a.text("kind")=="move"||a.text("kind")=="scroll"}});
        inputQuarantine.begin({"mouse"},id,a.text("kind")=="move"||a.text("kind")=="scroll");
        trace.record("input.journal.durable",{{"traceId",a.text("traceId")},{"inputQuarantine",inputQuarantine.status()}});
        auto result=hardwareAction(a,port,config.number("frameMs",40,20,200),config.number("clickMs",50,20,500),config.number("feedbackMs",5000,1000,60000),gainMemory);
        if(result.text("cleanup")=="release_confirmed") {
            heldButtons.erase(id);heldGenerations.erase(id);buttonReleaseUnconfirmed.erase(id);
        } else if(heldButtons.count(id)||requiresButtonRecovery(result)) {
            // A zero-button move that unexpectedly produces target button edges
            // is uncertain too, including feedback failure before a snapshot
            // returns its collected edges. Do not inject an unsolicited release.
            buttonReleaseUnconfirmed.insert(id);
        }
        inputQuarantine.finish({"mouse"},result,!heldButtons.empty()||!buttonReleaseUnconfirmed.empty());
        trace.record("input.journal.terminal",{{"traceId",a.text("traceId")},{"inputQuarantine",inputQuarantine.status()}});
        return result;
    }
    Json sequence(const std::string& id,const Json& a) {
        if(!config.boolean("allowHardwareInput")) throw std::runtime_error("hardware_input_disabled");
        std::set<std::string> scopes;
        for(auto& f:a.get("frames").items()) {
            auto kind=f.text("kind");if(kind!="mouse"&&kind!="keyboard")throw std::runtime_error("invalid_frame_kind");scopes.insert(kind);
        }
        const int generation=a.number("deviceGeneration",0,1,INT32_MAX);
        auto current=[&]{std::lock_guard<std::mutex> lock(stateMutex); return online.count(id)&&generations[id]==generation;};
        if(!current()) throw std::runtime_error("device_generation_changed");
        for(auto& f:a.get("frames").items()) {
            auto capability=f.text("kind")=="mouse"?"mouse_control":"keyboard_control";
            if(config.get("deviceCapabilities").get(id).text(capability,"unknown")!="supported") throw std::runtime_error("capability_unknown_or_unsupported");
        }
        PhysicalCoordinates coordinates;SequencePort port;
        port.now=[] {return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();};
        port.sleep=[](int ms){std::this_thread::sleep_for(std::chrono::milliseconds(ms));};
        port.current=current;port.cancelled=[&]{return cancelled();};
        port.write=[&](const Json& f){
            trace.record("sdk.frame.begin",{{"traceId",a.text("traceId")},{"frame",f}});
            int rc=0;
            if(f.text("kind")=="mouse") {
                int b=f.number("buttons",0,0,7); if(b) {heldButtons[id]=b;heldGenerations[id]=generation;}
                rc=f_um_inject_mouse(id.c_str(),b,f.number("dx",0,-127,127),f.number("dy",0,-127,127),f.number("wheel",0,-127,127));
                if(rc==1&&!b) heldButtons.erase(id);
            } else {
                std::vector<uint8_t> keys; for(auto& k:f.get("keys").items()) keys.push_back(static_cast<uint8_t>(k.integer()));
                int mod=f.number("modifiers",0,0,255); if(mod||!keys.empty()) {heldKeys.insert(id);heldGenerations[id]=generation;}
                rc=f_um_inject_keyboard(id.c_str(),mod,keys.data(),static_cast<int>(keys.size())); if(rc==1&&!mod&&keys.empty()) heldKeys.erase(id);
            }
            trace.record("sdk.frame.end",{{"traceId",a.text("traceId")},{"result",rc}});
            if(!heldButtons.count(id)&&!heldKeys.count(id))heldGenerations.erase(id);return rc;
        };
        // No button bit is ever set and no keyboard frame carries keys or
        // modifiers: nothing in this batch can leave held input behind.
        bool movementOnly=true;
        for(auto& f:a.get("frames").items()) {
            if(f.text("kind")=="mouse") { if(f.number("buttons",0,0,7)!=0)movementOnly=false; }
            else if(f.number("modifiers",0,0,255)!=0||(f.has("keys")&&!f.get("keys").items().empty()))movementOnly=false;
        }
        trace.record("input.journal.begin",{{"traceId",a.text("traceId")},{"scope",scopes.size()>1?"mouse,keyboard":scopes.empty()?"none":*scopes.begin()},{"movementOnly",movementOnly}});
        inputQuarantine.begin(scopes,id,movementOnly);
        trace.record("input.journal.durable",{{"traceId",a.text("traceId")},{"inputQuarantine",inputQuarantine.status()}});
        // Report-only telemetry: async key state always; cumulative Raw Input
        // edges too when a unique USB mouse collection can be bound. Any failure
        // here degrades to absent fields and never affects execution.
        const auto scanBefore=scanButtons();
        std::unique_ptr<RawButtonFeedback> rawTelemetry;
        ButtonSnapshot rawBaseline{};bool rawValid=false;
        if(scopes.count("mouse")) {
            try {
                if(current()&&f_um_get_device_count()==1&&f_um_get_connection_mode(id.c_str())==UM_CONN_USB) {
                    rawTelemetry=std::make_unique<RawButtonFeedback>(feedbackVid,feedbackPid,
                        [&](const char* stage,Json::Object fields){fields["traceId"]=a.text("traceId");fields["deviceId"]=id;trace.record(stage,std::move(fields));});
                    rawBaseline=rawTelemetry->snapshot();
                    rawValid=rawBaseline.healthy;
                }
            } catch(...) {rawValid=false;}
        }
        auto result=inputSequence(a,port);
        const auto scanAfter=scanButtons();
        Json::Object telemetry{{"buttonsBefore",scanBefore.report},{"buttonsAfter",scanAfter.report}};
        if(rawValid) {
            try {
                const auto edges=rawTelemetry->snapshot();
                if(edges.healthy) {
                    int64_t presses=0,releases=0;
                    for(int i=0;i<5;i++){presses+=static_cast<int64_t>(edges.downs[i]-rawBaseline.downs[i]);releases+=static_cast<int64_t>(edges.ups[i]-rawBaseline.ups[i]);}
                    telemetry["source"]="windows-raw-input";
                    telemetry["presses"]=presses;
                    telemetry["releases"]=releases;
                    telemetry["heldAfter"]=edges.held;
                }
            } catch(...) {}
        }
        std::get<Json::Object>(result.v)["telemetry"]=std::move(telemetry);
        bool held=(scopes.count("mouse")&&(!heldButtons.empty()||!buttonReleaseUnconfirmed.empty()||requiresButtonRecovery(result)))||(scopes.count("keyboard")&&!heldKeys.empty());
        inputQuarantine.finish(scopes,result,held);
        trace.record("input.journal.terminal",{{"traceId",a.text("traceId")},{"inputQuarantine",inputQuarantine.status()}});
        return result;
    }
    void stop() {
        if(!started) return;
        std::vector<std::string> ids;
        { std::lock_guard<std::mutex> lock(stateMutex); ids.assign(pendingClose.begin(),pendingClose.end()); }
        for(auto& id:ids) f_um_meeting_destroy(id.c_str());
        // Input cleanup was bounded by the original action. Never retry unknown
        // input while stopping unrelated voice / SDK lifetime resources.
        const bool inputClean=!inputQuarantine.any()&&heldButtons.empty()&&heldKeys.empty()&&buttonReleaseUnconfirmed.empty();
        bool clean=false;
        for(int i=0;i<60;i++) {
            { std::lock_guard<std::mutex> lock(stateMutex); clean=pendingClose.empty()&&meetingDrain.empty()&&physicalDrain.empty()&&physicalHeld.empty(); }
            if(clean) break; std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        f_um_register_connected(nullptr); f_um_register_disconnected(nullptr); f_um_register_message(nullptr); f_um_register_audio(nullptr); f_um_register_raw_frame(nullptr);
        f_um_sdk_close(); if(traceRegister)traceRegister(nullptr); started=false; active=nullptr;
        emit(Json::Object{{"type","cleanup"},{"physicalConfirmed",clean&&inputClean},{"sdkStopped",true},{"microphoneConfirmed",clean},{"inputQuarantined",!inputClean},{"inputQuarantine",inputQuarantine.status()}});
        if(!clean) throw std::runtime_error("hardware_cleanup_unconfirmed");
        // If input evidence could not be durably saved, preserve the process
        // journal rather than allowing a new worker to bypass the quarantine.
        if(!inputQuarantine.persistenceHealthy())throw std::runtime_error("input_journal_persistence_failed");
        if(!runMarker.empty() && !DeleteFileW(runMarker.c_str())) throw std::runtime_error("runtime_journal_cleanup_failed");
    }
};
Mouse* Mouse::active=nullptr;
const umcp_plugin_v1 api{sizeof(api),UMCP_PLUGIN_ABI,"umouse","1.0.0","[\"device\",\"voice.capture\",\"hardware.sequence\"]",createAdapter<Mouse>,callAdapter<Mouse>,stopAdapter<Mouse>,destroyAdapter<Mouse>};
}
extern "C" UMCP_EXPORT const umcp_plugin_v1* UMCP_CALL umcp_get_plugin(uint32_t abi) { return abi==UMCP_PLUGIN_ABI?&api:nullptr; }
