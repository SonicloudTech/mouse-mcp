#include "plugin_support.hpp"
#include <iostream>
#include <algorithm>
using namespace umcp;
namespace {
void check(bool ok,const char* message) { if(!ok) throw std::runtime_error(message); }
struct Harness {
    std::mutex mutex; std::vector<Json> events; std::vector<std::vector<uint8_t>> binaries;
    int cancellationCheck=0, cancelAt=0;
    static int event(void* user,const char* s,size_t n,const uint8_t* b,size_t bn) {
        auto p=static_cast<Harness*>(user); std::lock_guard<std::mutex> lock(p->mutex);
        p->events.push_back(Json::parse(std::string(s,n))); p->binaries.push_back(bn?std::vector<uint8_t>(b,b+bn):std::vector<uint8_t>{});return 1;
    }
    static int cancelled(void* user) { auto p=static_cast<Harness*>(user);return p->cancelAt&&++p->cancellationCheck>=p->cancelAt; }
    static void reply(void* user,const char* s,size_t n) { *static_cast<Json*>(user)=Json::parse(std::string(s,n)); }
    bool saw(const char* type) { std::lock_guard<std::mutex> lock(mutex); return std::any_of(events.begin(),events.end(),[&](const Json& j){return j.text("type")==type;}); }
    umcp_host_v1 api{sizeof(api),UMCP_PLUGIN_ABI,this,event,cancelled};
};
}
int wmain(int argc,wchar_t** argv) {
    try {
        if(argc!=4) throw std::runtime_error("usage: adapter-contract CASE BIN_DIR STATE_DIR");
        const auto name=utf8(argv[1]); const std::filesystem::path bin(argv[2]),state(argv[3]);
        const auto component=name.substr(0,name.find('-'));
        const auto vendor=bin/(name=="screen-missing-barrier"?L"umcp_test_vendor_legacy_screen.dll":L"umcp_test_vendor.dll");
        Library fixture;fixture.open(utf8(vendor.wstring()),sha256(readFile(vendor,128*1024*1024)));
        auto reset=fixture.symbol<void(*)(int)>("fixture_reset");
        auto trace=fixture.symbol<const char*(*)()>("fixture_trace");
        auto message=fixture.symbol<void(*)(const char*)>("fixture_message");
        auto audio=fixture.symbol<void(*)(int)>("fixture_audio");
        reset(name=="umouse-no-ack"||name=="umouse-quarantine-no-ack"?1:name=="umouse-wrong-boundary"?2:name=="asr-config-failure"?3:0);
        Harness harness; Library plugin; plugin.open(utf8((bin/wide("umcp_"+component+".dll")).wstring()));
        auto api=plugin.symbol<umcp_get_plugin_fn>("umcp_get_plugin")(UMCP_PLUGIN_ABI);
        check(api&&api->abi==1&&api->size==sizeof(*api),"plugin ABI mismatch");
        Json config=Json::Object{{"library",utf8(vendor.wstring())},{"librarySha256",sha256(readFile(vendor,128*1024*1024))},
            {"runtimeStateDir",utf8(state.wstring())},{"helper",utf8((state/L"never-launched-helper.exe").wstring())}};
        const bool inputCase=name=="umouse-mouse-quarantine"||name=="umouse-keyboard-quarantine"||name=="umouse-corrupt-quarantine"||name=="umouse-quarantine-no-ack";
        if(inputCase) {
            std::get<Json::Object>(config.v)["allowHardwareInput"]=true;
            std::get<Json::Object>(config.v)["deviceCapabilities"]=Json::Object{{"fake-mouse",Json::Object{{"mouse_control","supported"},{"keyboard_control","supported"}}}};
            auto scope=name=="umouse-keyboard-quarantine"?"keyboard":"mouse";
            std::ofstream out(state/L"native-input-quarantine.json");
            out<<(name=="umouse-corrupt-quarantine"?"{invalid":Json(Json::Object{{"schemaVersion",1},{"scopes",Json::Object{{scope,Json::Object{{"reason","release_unconfirmed"}}}}}}).dump());
        }
        Json error;auto encoded=config.dump();void* instance=api->create(&harness.api,encoded.data(),encoded.size(),Harness::reply,&error);
        struct Guard {
            const umcp_plugin_v1* api; void*& instance; Library& plugin; Library& fixture;
            ~Guard() { if(instance) { if(api->stop(instance)) api->destroy(instance); else { plugin.retain();fixture.retain(); } } }
        } guard{api,instance,plugin,fixture};
        if(name=="screen-missing-barrier") { check(!instance&&error.text("error")=="missing_export:sct_destroy_wait","legacy screen must fail closed"); }
        else {
            check(instance!=nullptr,"adapter create failed");
            auto call=[&](const char* method,Json args=Json::Object{}) { Json r;auto s=args.dump();api->call(instance,method,s.data(),s.size(),Harness::reply,&r);return r; };
            auto ok=[&](const char* method,Json args=Json::Object{}) {auto r=call(method,args);check(r.boolean("ok"),r.text("error","call failed").c_str());return r.get("result");};
            check(ok("status").text("version").find("fixture-only-")==0,"real vendor loaded unexpectedly");
            if(component=="umouse") {
                auto initialStart=ok("start");check(std::filesystem::exists(state/L"sdk-running.json"),"missing runtime marker");
                check(initialStart.get("inputQuarantine").object(),"start omitted input quarantine receipt");
                check(harness.saw("connected"),"startup callback lost");
                if(name=="umouse-input-query") {
                    // Read-only Windows check, with fixture vendor DLLs only.
                    auto status=ok("input.status");
                    check(status.get("cursor").object()&&status.get("foreground").get("rect").object(),"input status missing coordinates/target");
                    check(!status.get("foreground").text("windowId").empty(),"input status missing foreground identity");
                    check(call("cua.action").text("error")=="method_not_supported","removed automation method remains callable");
                    check(std::string(trace()).find("inject.FAKE")==std::string::npos,"read-only status sent hardware input");
                }
                ok("audio.source",Json::Object{{"deviceId","fake-mouse"}});audio(0);audio(1);
                check(harness.saw("audio")&&harness.saw("streamIncomplete"),"PCM validation/copy lost");
                if(inputCase) {
                    const bool keyboard=name=="umouse-keyboard-quarantine",both=name=="umouse-corrupt-quarantine";
                    auto q=ok("status").get("inputQuarantine");
                    check(q.boolean("mouse")==(!keyboard)&&q.boolean("keyboard")== (keyboard||both),"scope quarantine status incorrect");
                    check(initialStart.get("inputQuarantine").dump()==q.dump(),"start/status input quarantine mismatch");
                    auto blocked=call("input.sequence",Json::Object{{"deviceId","fake-mouse"},{"frames",Json::Array{Json::Object{{"kind",keyboard?"keyboard":"mouse"}}}}});
                    check(blocked.text("error")=="integer_out_of_range:deviceGeneration","old diagnostic prevented sequence argument validation");
                    check(!q.boolean("enforced"),"native diagnostic still enforced");
                    if(!keyboard)check(call("mouse.action",Json::Object{{"deviceId","fake-mouse"}}).text("error")=="integer_out_of_range:deviceGeneration","old diagnostic prevented mouse argument validation");
                    if(!both) {
                        // Validation-only request proves the other scope reaches
                        // its own action validation; no OS guard / input is run.
                        Json frame=keyboard?Json(Json::Object{{"kind","mouse"},{"dx",128}}):Json(Json::Object{{"kind","keyboard"},{"keys",Json::Array{1}}});
                        auto other=ok("input.sequence",Json::Object{{"deviceId","fake-mouse"},{"deviceGeneration",1},{"frames",Json::Array{frame}}});
                        check(other.text("outcome")=="rejected"&&other.get("transport").get("attempted").integer()==0,"independent input family blocked");
                        auto after=ok("status").get("inputQuarantine");
                        check(after.boolean("mouse")==!keyboard&&after.boolean("keyboard")==keyboard,"other scope cleared prior quarantine");
                    }
                } else {
                    auto denied=call("input.sequence",Json::Object{{"deviceId","fake-mouse"}});
                    check(denied.text("error")=="hardware_input_disabled","input gate bypass");
                }
                auto sent=ok("sleep.reset",Json::Object{{"deviceId","fake-mouse"}});
                check(!sent.boolean("confirmed"),"A2 falsely acknowledged");
                if(name=="umouse-ptt") {
                    message("{\"type\":\"keyEvent\",\"key\":\"speech\",\"action\":\"down\"}");
                    check(call("meeting.create").text("error")=="microphone_busy","PTT arbitration failed");
                    message("{\"type\":\"keyEvent\",\"key\":\"speech\",\"action\":\"up\"}");
                    check(call("meeting.create").text("error")=="microphone_busy","PTT drain skipped");
                    message("{\"type\":\"audioSegmentComplete\",\"reason\":\"key-up\",\"segment\":1}");
                }
                ok("meeting.create");
                bool uncertain=name=="umouse-no-ack"||name=="umouse-wrong-boundary"||name=="umouse-quarantine-no-ack";
                check(api->stop(instance)==(uncertain?0:1),"ACK/drain cleanup status incorrect");
                check(std::filesystem::exists(state/L"sdk-running.json")==uncertain,"runtime marker falsely clean");
                if(inputCase) {
                    check(std::filesystem::exists(state/L"native-input-quarantine.json"),"input evidence removed by stop");
                    const auto cleanup=harness.events.back();
                    check(cleanup.text("type")=="cleanup"&&!cleanup.boolean("physicalConfirmed")&&cleanup.boolean("inputQuarantined"),"input uncertainty falsely confirmed");
                    check(cleanup.boolean("microphoneConfirmed")==!uncertain,"microphone state conflated with input");
                    if(!uncertain) {
                        ok("start");check(ok("status").get("inputQuarantine").boolean(name=="umouse-keyboard-quarantine"?"keyboard":"mouse"),"restart lost input quarantine");
                        ok("meeting.create");check(api->stop(instance)==1,"input quarantine blocked restarted voice");
                    }
                }
                if(uncertain) { plugin.retain();fixture.retain();instance=nullptr; }
                else { api->destroy(instance);instance=nullptr; }
                std::string t=trace();check(t.find("mouse.message.detach")<t.find("mouse.close"),"mouse detach must precede close");
                check(t.find(".inject.FAKE")==std::string::npos,"unexpected input call");
            } else if(component=="asr") {
                Json begin=Json::Object{{"sessionId","session-1"},{"engines",Json::Object{}},{"params",Json::Object{}}};
                if(name=="asr-config-failure") { check(!call("begin",begin).boolean("ok"),"config failure accepted");check(std::string(trace()).find("asr.start")==std::string::npos,"start after invalid config"); }
                else {
                    ok("begin",begin);
                    check(call("append",Json::Object{{"sessionId","other"},{"pcmHex","0000"}}).text("error")=="asr_session_mismatch","ASR session leaked");
                    check(!call("append",Json::Object{{"sessionId","session-1"},{"pcmHex","00"}}).boolean("ok"),"odd PCM accepted");
                    ok("append",Json::Object{{"sessionId","session-1"},{"pcmHex","01000200"}});
                    ok("finish",Json::Object{{"sessionId","session-1"}});check(harness.saw("preview")&&harness.saw("final"),"ASR callbacks missing");
                }
                check(api->stop(instance)==1,"ASR stop failed");api->destroy(instance);instance=nullptr;
                std::string t=trace();check(t.find("asr.cancel")<t.find("asr.detach")&&t.find("asr.detach")<t.find("asr.destroy")&&t.find("asr.destroy")<t.find("asr.joined"),"ASR destroy barrier order invalid");
            } else if(component=="typer") {
                check(call("text",Json::Object{{"text","hello"}}).text("error")=="delivery_authorization_required","missing delivery authorization");
                check(call("text",Json::Object{{"text","hello\n"},{"deliveryAuthorized",true},{"operationId","op"}}).text("error")=="text_control_character","Enter injected");
                harness.cancelAt=name=="typer-cancel-after-create"?2:1;
                check(call("text",Json::Object{{"text","hello"},{"deliveryAuthorized",true},{"operationId","op"}}).text("error")=="cancelled_before_delivery","late cancellation ignored");
                check(api->stop(instance)==1,"typer stop failed");api->destroy(instance);instance=nullptr;
                std::string t=trace();check(t.find("typer.text.FAKE")==std::string::npos,"cancelled text sent");
                check((t.find("typer.create")!=std::string::npos)==(harness.cancelAt==2),"typer create ordering");
                if(harness.cancelAt==2)check(t.find("typer.destroy")!=std::string::npos,"typer context leaked");
            } else if(component=="screen") {
                ok("connect");ok("capture");check(harness.saw("screen"),"screen callback missing");
                check(harness.binaries.back()==std::vector<uint8_t>({1,2,3}),"screen borrowed bytes not copied");
                check(api->stop(instance)==1,"screen stop failed");api->destroy(instance);instance=nullptr;
                std::string t=trace();check(t.find("screen.cancel")<t.find("screen.shutdown")&&t.find("screen.shutdown")<t.find("screen.detach")&&t.find("screen.detach")<t.find("screen.destroy_wait"),"screen shutdown barrier order invalid");
                check(t.find("screen.destroy.UNSAFE")==std::string::npos,"unsafe screen destroy used");
            } else throw std::runtime_error("unknown case");
        }
        std::cout<<"PASS "<<name<<" (fake vendor only; no hardware/input/network)\n"<<trace();return 0;
    } catch(const std::exception& e) {std::cerr<<e.what()<<"\n";return 1;}
}
