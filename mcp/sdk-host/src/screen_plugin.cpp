#include "plugin_support.hpp"
using namespace umcp;
namespace {
using Event=void(*)(void*,const char*,const uint8_t*,int);
struct Screen final: Adapter {
    const char* (__cdecl *version)()=library.symbol<decltype(version)>("sct_version");
    void* (__cdecl *create)()=library.symbol<decltype(create)>("sct_create");
    void (__cdecl *destroy)(void*)=library.symbol<decltype(destroy)>("sct_destroy_wait");
    int (__cdecl *setEvent)(void*,Event,void*)=library.symbol<decltype(setEvent)>("sct_set_event_callback");
    int (__cdecl *setHelper)(void*,const char*)=library.symbol<decltype(setHelper)>("sct_set_helper_path");
    int (__cdecl *connect)(void*,int)=library.symbol<decltype(connect)>("sct_connect_async");
    int (__cdecl *capture)(void*,const char*)=library.symbol<decltype(capture)>("sct_start_capture");
    int (__cdecl *cancel)(void*)=library.symbol<decltype(cancel)>("sct_cancel_capture");
    int (__cdecl *shutdown)(void*,const char*)=library.symbol<decltype(shutdown)>("sct_shutdown");
    void* ctx=nullptr; std::string helper;
    Screen(const umcp_host_v1* h,const Json& c):Adapter(h,c),helper(c.text("helper")) {}
    static void event(void* p,const char* raw,const uint8_t* data,int n) {
        try { auto a=static_cast<Screen*>(p); a->emit(Json::Object{{"type","screen"},{"message",Json::parse(raw?raw:"{}")}},data,n>0?static_cast<size_t>(n):0); } catch(...) {}
    }
    Json call(const std::string& m,const Json& a) {
        if(m=="status") return Json::Object{{"version",version()},{"created",ctx!=nullptr}};
        if(m=="connect") {
            if(ctx) throw std::runtime_error("screen_already_created");
            if(helper.empty()||!std::filesystem::path(wide(helper)).is_absolute()) throw std::runtime_error("absolute_helper_required");
            ctx=create(); if(!ctx) throw std::runtime_error("screen_create_failed");
            if(setEvent(ctx,event,this)!=0||setHelper(ctx,helper.c_str())!=0) { stop(); throw std::runtime_error("screen_config_failed"); }
            return Json::Object{{"code",connect(ctx,a.number("timeoutMs",5000,100,10000))}};
        }
        if(!ctx) throw std::runtime_error("screen_not_connected");
        if(m=="capture") return Json::Object{{"code",capture(ctx,"mcp")}};
        if(m=="cancel") return Json::Object{{"code",cancel(ctx)}};
        throw std::runtime_error("method_not_supported");
    }
    void stop() { if(ctx) { cancel(ctx); shutdown(ctx,"close_now"); setEvent(ctx,nullptr,nullptr); destroy(ctx); ctx=nullptr; } }
};
const umcp_plugin_v1 api{sizeof(api),UMCP_PLUGIN_ABI,"screen","1.0.0","[\"screen.capture\"]",createAdapter<Screen>,callAdapter<Screen>,stopAdapter<Screen>,destroyAdapter<Screen>};
}
extern "C" UMCP_EXPORT const umcp_plugin_v1* UMCP_CALL umcp_get_plugin(uint32_t abi) { return abi==UMCP_PLUGIN_ABI?&api:nullptr; }
