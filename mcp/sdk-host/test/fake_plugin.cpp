#include "plugin_support.hpp"
#include <thread>
#include <chrono>
using namespace umcp;
namespace {
struct Fake {
    umcp_host_v1 host; bool failStop=false;
    Fake(const umcp_host_v1* h,const Json& c):host(*h),failStop(c.boolean("failStop")){}
    Json call(const std::string& method,const Json& args) {
        if(method=="echo") return args;
        if(method=="delay") {
            for(int ms=0,n=args.number("ms",100,0,20000);ms<n;ms+=5) { if(host.is_cancelled(host.user)) return Json::Object{{"cancelled",true}}; std::this_thread::sleep_for(std::chrono::milliseconds(5)); }
            return Json::Object{{"cancelled",false}};
        }
        if(method=="crash") TerminateProcess(GetCurrentProcess(),86);
        if(method=="hang") { const std::string s="{\"type\":\"hanging\"}"; host.emit(host.user,s.data(),s.size(),nullptr,0); Sleep(INFINITE); }
        if(method=="event") { auto s=args.dump(); host.emit(host.user,s.data(),s.size(),nullptr,0); return Json::Object{{"emitted",true}}; }
        if(method=="log") { printf("native stdout must not corrupt RPC\n"); fflush(stdout); return Json::Object{{"logged",true}}; }
        throw std::runtime_error("fake_method_unknown");
    }
    void stop(){ if(failStop) throw std::runtime_error("fake_stop_failed"); }
};
#ifdef UMCP_BAD_ABI
constexpr unsigned abi=999;
#else
constexpr unsigned abi=UMCP_PLUGIN_ABI;
#endif
const umcp_plugin_v1 api{sizeof(api),abi,"fake","1.0.0","[\"test.echo\"]",createAdapter<Fake>,callAdapter<Fake>,stopAdapter<Fake>,destroyAdapter<Fake>};
}
extern "C" UMCP_EXPORT const umcp_plugin_v1* UMCP_CALL umcp_get_plugin(uint32_t) { return &api; }
