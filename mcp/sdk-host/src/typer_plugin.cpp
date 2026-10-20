#include "plugin_support.hpp"
using namespace umcp;
namespace {
struct Typer final: Adapter {
    const char* (__cdecl *version)()=library.symbol<decltype(version)>("typer_version");
    void* (__cdecl *create)(const void*)=library.symbol<decltype(create)>("typer_create");
    void (__cdecl *destroy)(void*)=library.symbol<decltype(destroy)>("typer_destroy");
    int (__cdecl *typeText)(void*,const char*)=library.symbol<decltype(typeText)>("typer_type_text");
    void* ctx=nullptr;
    Typer(const umcp_host_v1* h,const Json& c):Adapter(h,c){}
    Json call(const std::string& m,const Json& a) {
        if(m=="status") return Json::Object{{"version",version()},{"created",ctx!=nullptr}};
        if(m!="text") throw std::runtime_error("method_not_supported");
        auto text=a.text("text");
        if(text.empty()||text.size()>65536) throw std::runtime_error("text_size_limit");
        for(unsigned char c:text) if(c<32||c==127) throw std::runtime_error("text_control_character");
        // Delivery ledger and desktop authorization are required in the caller.
        if(!a.boolean("deliveryAuthorized") || a.text("operationId").empty()) throw std::runtime_error("delivery_authorization_required");
        if(cancelled()) throw std::runtime_error("cancelled_before_delivery");
        if(!ctx) { ctx=create(nullptr); if(!ctx) throw std::runtime_error("typer_create_failed"); }
        if(cancelled()) throw std::runtime_error("cancelled_before_delivery");
        // Input is only permitted on the normal interactive desktop. Never
        // switch a desktop or foreground window to make delivery possible.
        HDESK desktop=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS);
        if(!desktop) throw std::runtime_error("interactive_desktop_unavailable");
        wchar_t name[256]{}; DWORD needed=0;
        bool normal=GetUserObjectInformationW(desktop,UOI_NAME,name,sizeof(name),&needed)&&_wcsicmp(name,L"Default")==0;
        CloseDesktop(desktop);
        if(!normal||!GetForegroundWindow()) throw std::runtime_error("interactive_desktop_unavailable");
        int rc=typeText(ctx,text.c_str()); return Json::Object{{"code",rc},{"submitted",rc==0},{"visibleConfirmed",false}};
    }
    void stop() { if(ctx) { destroy(ctx); ctx=nullptr; } }
};
const umcp_plugin_v1 api{sizeof(api),UMCP_PLUGIN_ABI,"typer","1.0.0","[\"text.delivery\"]",createAdapter<Typer>,callAdapter<Typer>,stopAdapter<Typer>,destroyAdapter<Typer>};
}
extern "C" UMCP_EXPORT const umcp_plugin_v1* UMCP_CALL umcp_get_plugin(uint32_t abi) { return abi==UMCP_PLUGIN_ABI?&api:nullptr; }
