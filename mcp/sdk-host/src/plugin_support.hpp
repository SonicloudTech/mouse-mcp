#pragma once
#include "umcp_plugin.h"
#include "json.hpp"
#include "platform.hpp"
#include <atomic>
#include <mutex>

namespace umcp {
// Covers argument construction too: noexcept emit alone cannot catch exceptions
// thrown while building a Json object before entering emit.
template<class F> void callbackBoundary(F f) noexcept { try { f(); } catch(...) { TerminateProcess(GetCurrentProcess(),76); } }
inline void reply(umcp_reply_fn fn,void* user,const Json& j) { auto s=j.dump(); fn(user,s.data(),s.size()); }
template<class F> void boundary(umcp_reply_fn fn,void* user,F f) noexcept {
    try { reply(fn,user,success(f())); }
    catch(const std::exception& e) { try { reply(fn,user,failure(e.what())); } catch(...){} }
    catch(...) { try { reply(fn,user,failure("plugin_exception")); } catch(...){} }
}
struct Adapter {
    umcp_host_v1 host{};
    Library library;
    explicit Adapter(const umcp_host_v1* h,const Json& config):host(*h) { library.open(config.text("library"),config.text("librarySha256")); }
    bool cancelled() const { return host.is_cancelled && host.is_cancelled(host.user); }
    void emit(const Json& e,const uint8_t* pcm=nullptr,size_t n=0) noexcept {
        // A serialization/callback failure must not silently turn incomplete
        // audio into a successful transcript. The host handles queue rejection.
        callbackBoundary([&]{ auto s=e.dump(); host.emit(host.user,s.data(),s.size(),pcm,n); });
    }
};
inline std::vector<uint8_t> unhex(const std::string& s,size_t max) {
    if(s.size()%2 || s.size()>max*2) throw std::runtime_error("invalid_binary_size");
    std::vector<uint8_t> out; out.reserve(s.size()/2);
    auto digit=[](char c)->int { if(c>='0'&&c<='9') return c-'0'; if(c>='a'&&c<='f') return c-'a'+10; if(c>='A'&&c<='F') return c-'A'+10; throw std::runtime_error("invalid_hex"); };
    for(size_t i=0;i<s.size();i+=2) out.push_back(static_cast<uint8_t>(digit(s[i])*16+digit(s[i+1]))); return out;
}
template<class T> void* createAdapter(const umcp_host_v1* h,const char* c,size_t n,umcp_reply_fn error,void* u) noexcept {
    try {
        if(!h || h->size<sizeof(*h) || h->abi!=UMCP_PLUGIN_ABI || !h->emit) throw std::runtime_error("host_abi_mismatch");
        return new T(h,Json::parse(std::string(c,n)));
    } catch(const std::exception& e) { try { reply(error,u,failure(e.what())); } catch(...){} return nullptr; }
    catch(...) { return nullptr; }
}
template<class T> void callAdapter(void* p,const char* m,const char* a,size_t n,umcp_reply_fn r,void* u) noexcept {
    boundary(r,u,[&]{ if(!p) throw std::runtime_error("plugin_not_created"); return static_cast<T*>(p)->call(m,Json::parse(std::string(a,n))); });
}
template<class T> int stopAdapter(void* p) noexcept { try { if(p) static_cast<T*>(p)->stop(); return 1; } catch(...) { return 0; } }
template<class T> void destroyAdapter(void* p) noexcept { delete static_cast<T*>(p); }
}
