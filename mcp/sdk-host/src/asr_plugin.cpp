#include "plugin_support.hpp"
using namespace umcp;
namespace {
// Frozen public AsrTools 0.2.2 callback C layout; no SDK implementation linked.
struct Callbacks {
    size_t size; void* user;
    void (*state)(void*,int); void (*intermediate)(void*,const char*); void (*finalText)(void*,const char*);
    void (*raw)(void*,const char*); void (*error)(void*,int,const char*); void (*warning)(void*,int,const char*);
};
struct Asr final: Adapter {
    const char* (__cdecl *version)()=library.symbol<decltype(version)>("atr_version");
    void* (__cdecl *create)(const Callbacks*,const char*)=library.symbol<decltype(create)>("atr_create");
    void (__cdecl *destroy)(void*)=library.symbol<decltype(destroy)>("atr_destroy");
    int (__cdecl *setCallbacks)(void*,const Callbacks*)=library.symbol<decltype(setCallbacks)>("atr_set_callbacks");
    int (__cdecl *configure)(void*,const char*)=library.symbol<decltype(configure)>("atr_set_engine_config");
    int (__cdecl *start)(void*,const char*)=library.symbol<decltype(start)>("atr_start");
    int (__cdecl *append)(void*,const uint8_t*,int)=library.symbol<decltype(append)>("atr_append_audio");
    int (__cdecl *finish)(void*)=library.symbol<decltype(finish)>("atr_stop");
    int (__cdecl *cancel)(void*)=library.symbol<decltype(cancel)>("atr_cancel");
    int (__cdecl *state)(void*)=library.symbol<decltype(state)>("atr_state");
    void* ctx=nullptr;
    std::string session;
    Asr(const umcp_host_v1* h,const Json& c):Adapter(h,c) {}
    static void onState(void* p,int s) { callbackBoundary([&]{ auto a=static_cast<Asr*>(p); a->emit(Json::Object{{"type","state"},{"sessionId",a->session},{"state",s}}); }); }
    static void onPreview(void* p,const char* s) { callbackBoundary([&]{ auto a=static_cast<Asr*>(p); a->emit(Json::Object{{"type","preview"},{"sessionId",a->session},{"text",s?s:""}}); }); }
    static void onFinal(void* p,const char* s) { callbackBoundary([&]{ auto a=static_cast<Asr*>(p); a->emit(Json::Object{{"type","final"},{"sessionId",a->session},{"text",s?s:""}}); }); }
    static void onError(void* p,int code,const char*) { callbackBoundary([&]{ auto a=static_cast<Asr*>(p); a->emit(Json::Object{{"type","error"},{"sessionId",a->session},{"code",code}}); }); }
    static void onWarning(void* p,int kind,const char*) { callbackBoundary([&]{ auto a=static_cast<Asr*>(p); a->emit(Json::Object{{"type","warning"},{"sessionId",a->session},{"kind",kind}}); }); }
    Json call(const std::string& m,const Json& a) {
        if(m=="status") return Json::Object{{"version",version()},{"state",ctx?state(ctx):0}};
        if(m=="begin") {
            if(ctx) throw std::runtime_error("asr_busy");
            session=a.text("sessionId"); if(session.empty()) throw std::runtime_error("session_required");
            Callbacks cb{sizeof(cb),this,onState,onPreview,onFinal,nullptr,onError,onWarning};
            ctx=create(&cb,"{\"log_level\":2}"); if(!ctx) throw std::runtime_error("asr_create_failed");
            int rc=configure(ctx,a.get("engines").dump().c_str());
            if(!rc) rc=start(ctx,a.get("params").dump().c_str());
            if(rc) { stop(); throw std::runtime_error("asr_start_failed:"+std::to_string(rc)); }
            return Json::Object{{"code",0}};
        }
        if(!ctx || a.text("sessionId")!=session) throw std::runtime_error("asr_session_mismatch");
        if(m=="append") { auto pcm=unhex(a.text("pcmHex"),65536); if(pcm.empty()||pcm.size()%2) throw std::runtime_error("invalid_pcm"); return Json::Object{{"code",append(ctx,pcm.data(),static_cast<int>(pcm.size()))}}; }
        if(m=="finish") return Json::Object{{"code",finish(ctx)}};
        if(m=="cancel") return Json::Object{{"code",cancel(ctx)}};
        if(m=="dispose") { stop(); return Json::Object{{"disposed",true}}; }
        throw std::runtime_error("method_not_supported");
    }
    void stop() {
        if(ctx) {
            cancel(ctx);
            Callbacks empty{}; empty.size=sizeof(empty);
            if(setCallbacks(ctx,&empty)!=0) throw std::runtime_error("asr_callback_detach_failed");
            destroy(ctx); ctx=nullptr; session.clear();
        }
    }
};
const umcp_plugin_v1 api{sizeof(api),UMCP_PLUGIN_ABI,"asr","1.0.0","[\"asr.streaming\"]",createAdapter<Asr>,callAdapter<Asr>,stopAdapter<Asr>,destroyAdapter<Asr>};
}
extern "C" UMCP_EXPORT const umcp_plugin_v1* UMCP_CALL umcp_get_plugin(uint32_t abi) { return abi==UMCP_PLUGIN_ABI?&api:nullptr; }
