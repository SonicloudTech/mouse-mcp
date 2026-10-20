#include "plugin_support.hpp"
#include "maintenance.hpp"
#include "diagnostics.hpp"
#include <iostream>
#include <deque>
#include <condition_variable>
#include <thread>
#include <io.h>
#include <fcntl.h>
#include <chrono>
#include <regex>
#include <set>
#include <winsock2.h>
#include <iphlpapi.h>

using namespace umcp;
namespace {
constexpr size_t maxFrame=4*1024*1024, maxQueued=16*1024*1024;
std::string hex(const uint8_t* b,size_t n) {
    static const char* h="0123456789abcdef"; std::string s; s.reserve(n*2);
    for(size_t i=0;i<n;i++) { s.push_back(h[b[i]>>4]); s.push_back(h[b[i]&15]); } return s;
}
struct Output {
    HANDLE pipe=INVALID_HANDLE_VALUE;
    std::mutex mutex; std::condition_variable wake; std::deque<std::string> queue;
    size_t bytes=0; bool closed=false; std::atomic<bool> broken{false}; std::atomic<uint64_t> dropped{0}; std::thread thread;
    Output() {
        auto process=GetCurrentProcess();
        if(!DuplicateHandle(process,GetStdHandle(STD_OUTPUT_HANDLE),process,&pipe,0,FALSE,DUPLICATE_SAME_ACCESS)) throw std::runtime_error("output_pipe_required");
        // Native SDK logs must NEVER share the private RPC output pipe.
        _dup2(_fileno(stderr),_fileno(stdout)); SetStdHandle(STD_OUTPUT_HANDLE,GetStdHandle(STD_ERROR_HANDLE));
        thread=std::thread([this]{ run(); });
    }
    ~Output(){ finish(); if(pipe!=INVALID_HANDLE_VALUE) CloseHandle(pipe); }
    bool send(const Json& j,bool event=false) {
        auto s=j.dump()+"\n";
        std::lock_guard<std::mutex> l(mutex);
        if(closed||broken) return false;
        if(s.size()>9*1024*1024 || bytes+s.size()>maxQueued || queue.size()>=256) {
            if(event) { ++dropped; return false; }
            broken=true; wake.notify_all(); return false; // Responses cannot be silently discarded.
        }
        bytes+=s.size(); queue.push_back(std::move(s)); wake.notify_one(); return true;
    }
    void run() {
        for(;;) {
            std::string s;
            { std::unique_lock<std::mutex> l(mutex); wake.wait(l,[&]{return closed||broken||!queue.empty();});
              if(broken || (closed&&queue.empty())) return;
              s=std::move(queue.front()); queue.pop_front(); bytes-=s.size(); }
            size_t done=0;
            while(done<s.size()) { DWORD wrote=0;
                if(!WriteFile(pipe,s.data()+done,static_cast<DWORD>(s.size()-done),&wrote,nullptr)||!wrote) { broken=true; return; }
                done+=wrote;
            }
        }
    }
    void finish(){ {std::lock_guard<std::mutex> l(mutex); closed=true; wake.notify_all();} if(thread.joinable()) thread.join(); }
};
struct Plugin;
struct Runtime {
    Output out;
    DiagnosticLog trace{"host"};
    std::string epoch;
    std::atomic<bool> stopping{false};
    std::mutex requestMutex;
    std::set<std::string> pendingIds,cancelledIds;
    std::string currentId;
    std::atomic<int64_t> sequence{0};
    std::vector<std::unique_ptr<Plugin>> plugins;
    Json::Array unavailable;
    explicit Runtime(std::string e):epoch(std::move(e)){}
    void respond(const Json& id,const Json& result) {
        trace.record("native.rpc.response",{{"rpcId",id}});
        if(std::holds_alternative<std::string>(id.v)) { std::lock_guard<std::mutex> lock(requestMutex); pendingIds.erase(id.str()); cancelledIds.erase(id.str()); }
        out.send(Json::Object{{"kind","response"},{"id",id},{"workerEpoch",epoch},{"body",result}});
    }
    static int UMCP_CALL isCancelled(void* p);
    static int UMCP_CALL event(void* p,const char* json,size_t n,const uint8_t* data,size_t size);
};
struct Plugin {
    Runtime& runtime; Library library; const umcp_plugin_v1* api=nullptr; void* context=nullptr;
    std::string id; bool stopped=false,stopAttempted=false;
    umcp_host_v1 services{};
    explicit Plugin(Runtime& r):runtime(r) { services={sizeof(services),UMCP_PLUGIN_ABI,this,Runtime::event,Runtime::isCancelled}; }
    static void UMCP_CALL capture(void* p,const char* text,size_t n) {
        auto sink=static_cast<std::pair<int,std::string>*>(p); ++sink->first;
        if(n>8*1024*1024) { sink->second="{\"ok\":false,\"error\":\"plugin_response_limit\"}"; return; }
        sink->second.assign(text,n);
    }
    void load(const Json& spec,const std::filesystem::path& root,bool testing) {
        id=spec.text("id");
        if(!std::regex_match(id,std::regex("[a-z][a-z0-9_-]{0,31}"))) throw std::runtime_error("invalid_plugin_id");
        if(testing && id!="fake") throw std::runtime_error("test_profile_requires_fake_plugin");
        if(!testing && id=="fake") throw std::runtime_error("fake_plugin_not_production");
        if(!std::filesystem::path(wide(spec.text("path"))).is_absolute()) throw std::runtime_error("absolute_plugin_path_required");
        auto p=std::filesystem::weakly_canonical(std::filesystem::path(wide(spec.text("path"))));
        auto relative=p.lexically_relative(root);
        if(relative.empty()||relative.is_absolute()||*relative.begin()==L"..") throw std::runtime_error("plugin_outside_bundle");
        auto hash=spec.text("sha256"); if(!std::regex_match(hash,std::regex("[0-9a-f]{64}"))) throw std::runtime_error("plugin_hash_required");
        library.open(utf8(p.native()),hash);
        auto get=library.symbol<umcp_get_plugin_fn>("umcp_get_plugin"); api=get(UMCP_PLUGIN_ABI);
        if(!api||api->size<sizeof(umcp_plugin_v1)||api->abi!=UMCP_PLUGIN_ABI||!api->id||id!=api->id||!api->version||!api->capabilities_json||!api->create||!api->call||!api->stop||!api->destroy) throw std::runtime_error("plugin_abi_mismatch");
        if(!Json::parse(api->capabilities_json).array()) throw std::runtime_error("invalid_capabilities");
        auto config=spec.get("config"); if(!config.object()) throw std::runtime_error("plugin_config_required");
        if(!testing && !std::regex_match(config.text("librarySha256"),std::regex("[0-9a-f]{64}"))) throw std::runtime_error("vendor_library_hash_required");
        auto s=config.dump(); std::pair<int,std::string> error{};
        context=api->create(&services,s.data(),s.size(),capture,&error);
        if(!context) throw std::runtime_error(error.second.empty()?"plugin_create_failed":Json::parse(error.second).text("error","plugin_create_failed"));
    }
    Json call(const std::string& m,const Json& args) {
        if(!context||stopped) throw std::runtime_error("plugin_stopped");
        std::pair<int,std::string> response{}; auto a=args.dump(); api->call(context,m.c_str(),a.data(),a.size(),capture,&response);
        if(response.first!=1) throw std::runtime_error("plugin_reply_contract");
        return Json::parse(response.second);
    }
    bool stop() { if(!context||stopped) return true; if(stopAttempted) return false; stopAttempted=true; stopped=api->stop(context)==1; return stopped; }
    ~Plugin(){ if(context) { if(stopped||stop()) {api->destroy(context);context=nullptr;} else { library.retain(); TerminateProcess(GetCurrentProcess(),75); } } }
};
int Runtime::isCancelled(void* p) {
    auto& r=static_cast<Plugin*>(p)->runtime; if(r.stopping) return 1;
    std::lock_guard<std::mutex> lock(r.requestMutex); return r.cancelledIds.count(r.currentId)?1:0;
}
int Runtime::event(void* p,const char* json,size_t n,const uint8_t* data,size_t size) {
    auto plugin=static_cast<Plugin*>(p); auto& r=plugin->runtime;
    try {
        if(n>1024*1024 || size>4*1024*1024 || (size&&!data)) { ++r.out.dropped; return 0; }
        Json::Object event{{"kind","event"},{"workerEpoch",r.epoch},{"plugin",plugin->id},{"seq",++r.sequence},{"event",Json::parse(std::string(json,n))}};
        if(size) event["binaryHex"]=hex(data,size);
        if(r.out.send(event,true)) return 1;
        r.stopping=true; // Missing PCM/control cannot be followed by an apparently successful delivery.
        return 0;
    } catch(...) { ++r.out.dropped; r.stopping=true; return 0; }
}
struct Input {
    Runtime& runtime; std::mutex mutex; std::condition_variable wake; std::deque<Json> commands; size_t bytes=0;
    std::atomic<bool> eof{false}; std::thread thread;
    explicit Input(Runtime& r):runtime(r),thread([this]{ read(); }){}
    void read() {
        std::string line; char c;
        while(std::cin.get(c)) {
            if(c!='\n') { if(line.size()>=maxFrame) break; line.push_back(c); continue; }
            try {
                auto request=Json::parse(line); auto method=request.text("method");
                auto id=request.text("id");
                if(!request.object() || request.text("workerEpoch")!=runtime.epoch || id.empty() || id.size()>128) throw std::runtime_error("invalid_request_envelope");
                runtime.trace.record("native.rpc.received",{{"rpcId",id},{"method",method},{"operation",request.text("operation")},{"traceId",request.get("args").text("traceId")}});
                {
                    std::lock_guard<std::mutex> lock(runtime.requestMutex);
                    if(runtime.pendingIds.size()>=128) throw std::runtime_error("request_limit");
                    if(!runtime.pendingIds.insert(id).second) { runtime.stopping=true; throw std::runtime_error("duplicate_request_id"); }
                    if(method=="cancel") {
                        auto target=request.text("targetId");
                        if(runtime.pendingIds.count(target)) runtime.cancelledIds.insert(target);
                    }
                }
                if(method=="shutdown") runtime.stopping=true;
                std::lock_guard<std::mutex> l(mutex);
                if(commands.size()>=64 || bytes+line.size()>maxQueued) { runtime.respond(request.get("id"),failure("request_queue_full")); }
                else { bytes+=line.size(); commands.push_back(std::move(request)); wake.notify_one(); }
            } catch(const std::exception& e) { runtime.respond({},failure(e.what())); }
            line.clear();
        }
        runtime.stopping=true;
        { std::lock_guard<std::mutex> l(mutex); eof=true; wake.notify_all(); }
    }
    bool next(Json& j) {
        std::unique_lock<std::mutex> l(mutex);
        wake.wait_for(l,std::chrono::seconds(1),[&]{return eof||!commands.empty();});
        if(commands.empty()) return false;
        j=std::move(commands.front()); commands.pop_front(); bytes=0; for(auto& q:commands) bytes+=q.dump().size(); return true;
    }
    ~Input(){ if(thread.joinable()) { CancelSynchronousIo(thread.native_handle()); thread.join(); } }
};
int hostMain(const std::string& manifestPath,const std::string& epoch,DWORD parentPid,bool testAllowed) {
    if(GetFileType(GetStdHandle(STD_INPUT_HANDLE))!=FILE_TYPE_PIPE || GetFileType(GetStdHandle(STD_OUTPUT_HANDLE))!=FILE_TYPE_PIPE) throw std::runtime_error("private_pipes_required");
    if(!std::regex_match(epoch,std::regex("[a-zA-Z0-9-]{8,80}"))) throw std::runtime_error("invalid_epoch");
    HANDLE parent=OpenProcess(SYNCHRONIZE,FALSE,parentPid); if(!parent||parentPid==GetCurrentProcessId()) throw std::runtime_error("parent_process_required");
    HANDLE job=CreateJobObjectW(nullptr,nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if(!job||!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))||!AssignProcessToJobObject(job,GetCurrentProcess())) throw std::runtime_error("process_job_failed");
    HANDLE finished=CreateEventW(nullptr,TRUE,FALSE,nullptr);if(!finished)throw std::runtime_error("watchdog_event_failed");
    std::thread watchdog([&]{HANDLE events[]{parent,finished};auto result=WaitForMultipleObjects(2,events,FALSE,INFINITE);
        if(result==WAIT_OBJECT_0||result==WAIT_FAILED)TerminateProcess(GetCurrentProcess(),74);});
    int exitCode=0;
    try {
        auto manifest=Json::parse(readFile(std::filesystem::path(wide(manifestPath)),1024*1024));
        if(manifest.number("schemaVersion",0,1,1)!=1) throw std::runtime_error("manifest_version");
        bool testing=manifest.text("profile")=="test";
        if(testing!=testAllowed) throw std::runtime_error("profile_mismatch");
        if(!testing&&manifest.text("profile")!="production") throw std::runtime_error("invalid_profile");
        auto root=std::filesystem::canonical(std::filesystem::path(wide(manifest.text("root"))));
        PipeLease workerLease,legacyLease;
        std::string suffix=testing?"test-"+manifest.text("testNamespace"):"sid-"+currentSid();
        if(testing && !std::regex_match(suffix,std::regex("test-[a-zA-Z0-9-]{8,80}"))) throw std::runtime_error("test_namespace_required");
        workerLease.acquire(wide("\\\\.\\pipe\\umouse-sdk-host-"+suffix));
        if(!testing) {
            wchar_t home[32768]; DWORD n=GetEnvironmentVariableW(L"USERPROFILE",home,32768); if(!n||n>=32768) throw std::runtime_error("user_profile_required");
            std::wstring lower(home,n); for(auto& ch:lower) ch=static_cast<wchar_t>(towlower(ch));
            legacyLease.acquire(wide("\\\\.\\pipe\\umouse-sdk-"+sha256(utf8(lower)).substr(0,24)));
        }
        Runtime runtime(epoch);
        std::set<std::string> ids; Json::Array loaded;
        for(auto& spec:manifest.get("plugins").items()) {
            auto id=spec.text("id"); if(!ids.insert(id).second) throw std::runtime_error("duplicate_plugin_id");
            auto p=std::make_unique<Plugin>(runtime);
            try {
                p->load(spec,root,testing);
                loaded.push_back(Json::Object{{"id",p->id},{"version",p->api->version},{"abi",static_cast<int>(p->api->abi)},{"capabilities",Json::parse(p->api->capabilities_json)},
                    {"vendorLibrary",spec.get("config").text("library")},{"vendorSha256",spec.get("config").text("librarySha256")}});
                runtime.plugins.push_back(std::move(p));
            } catch(const std::exception& e) {
                if(spec.boolean("required",false)) throw;
                runtime.unavailable.push_back(Json::Object{{"id",id},{"error",e.what()}});
            }
        }
        runtime.out.send(Json::Object{{"kind","ready"},{"protocolVersion",1},{"workerEpoch",epoch},{"pid",static_cast<int>(GetCurrentProcessId())},{"sid",currentSid()},{"windowsSessionId",static_cast<int>(currentSession())},{"plugins",loaded},{"unavailable",runtime.unavailable},{"sdkInitialized",false}});
        Input input(runtime); Json req;
        for(;;) {
            if(!input.next(req)) {
                if(input.eof||runtime.out.broken||runtime.stopping) break;
                runtime.out.send(Json::Object{{"kind","heartbeat"},{"workerEpoch",epoch},{"droppedEvents",static_cast<int64_t>(runtime.out.dropped.load())}}); continue;
            }
            auto method=req.text("method"); auto id=req.get("id");
            runtime.trace.record("native.rpc.execute",{{"rpcId",id},{"method",method}});
            if(method=="shutdown") { runtime.respond(id,success(Json::Object{{"stopping",true}})); break; }
            if(method=="cancel") { runtime.respond(id,success(Json::Object{{"cancelled",true}})); continue; }
            if(runtime.stopping) { runtime.respond(id,failure("worker_stopping")); continue; }
            { std::lock_guard<std::mutex> lock(runtime.requestMutex); runtime.currentId=id.str(); }
            try {
                { std::lock_guard<std::mutex> lock(runtime.requestMutex); if(runtime.cancelledIds.count(id.str())) throw std::runtime_error("cancelled_before_execution"); }
                if(method=="status") { runtime.respond(id,success(Json::Object{{"plugins",loaded},{"unavailable",runtime.unavailable},{"droppedEvents",static_cast<int64_t>(runtime.out.dropped.load())}})); continue; }
                if(method!="plugin.call") throw std::runtime_error("method_not_supported");
                auto plugin=req.text("plugin"); Plugin* found=nullptr; for(auto& p:runtime.plugins) if(p->id==plugin) found=p.get();
                if(!found) throw std::runtime_error("plugin_unavailable");
                runtime.respond(id,found->call(req.text("operation"),req.get("args")));
            } catch(const std::exception& e) { runtime.respond(id,failure(e.what())); }
        }
        runtime.stopping=true; bool clean=true;
        // Stop producers first, then ASR/UI/input consumers. Reverse destruction
        // is only safe after every plugin has acknowledged its stop barrier.
        for(auto& p:runtime.plugins) if(p->id=="umouse") clean=p->stop()&&clean;
        for(auto& p:runtime.plugins) if(p->id!="umouse") clean=p->stop()&&clean;
        runtime.out.send(Json::Object{{"kind","stopped"},{"workerEpoch",epoch},{"clean",clean}});
        runtime.out.finish();
        if(!clean) { TerminateProcess(GetCurrentProcess(),75); }
        runtime.plugins.clear(); exitCode=0;
    } catch(const std::exception& e) { std::cerr<<"sdk-host: "<<e.what()<<'\n'; exitCode=70; }
    SetEvent(finished);watchdog.join();CloseHandle(finished);CloseHandle(parent);
    // The job handle is deliberately retained until process exit so owned
    // helper descendants cannot outlive this host. No other process gets it.
    (void)job; return exitCode;
}
}
int wmain(int argc,wchar_t** argv) {
    try {
        if(argc==5&&std::wstring(argv[1])==L"--service-run")return serviceRun(argv[2],argv[3],argv[4]);
        if(argc==7&&std::wstring(argv[1])==L"--recover-state"&&std::wstring(argv[6])==L"--hardware-reset-confirmed") {
            std::cout<<recoverState(argv[2],utf8(argv[3]),argv[4],utf8(argv[5])).dump()<<'\n';return 0;
        }
        if(argc==8&&std::wstring(argv[1])==L"--recover-state"&&std::wstring(argv[7])==L"--hardware-reset-confirmed") {
            std::cout<<recoverState(argv[2],utf8(argv[3]),argv[4],utf8(argv[5]),utf8(argv[6])).dump()<<'\n';return 0;
        }
        if(argc==9&&std::wstring(argv[1])==L"--recover-state"&&std::wstring(argv[8])==L"--hardware-reset-confirmed") {
            std::cout<<recoverState(argv[2],utf8(argv[3]),argv[4],utf8(argv[5]),utf8(argv[6]),utf8(argv[7])).dump()<<'\n';return 0;
        }
        if(argc==4 && std::wstring(argv[1])==L"--tcp-owner") {
            auto serverPort=std::stoul(argv[2]),clientPort=std::stoul(argv[3]);
            if(!serverPort||serverPort>65535||!clientPort||clientPort>65535) throw std::runtime_error("invalid_port");
            DWORD size=0; GetExtendedTcpTable(nullptr,&size,FALSE,AF_INET,TCP_TABLE_OWNER_PID_ALL,0);
            if(!size||size>16*1024*1024) throw std::runtime_error("tcp_table_unavailable");
            std::vector<unsigned char> bytes(size);
            if(GetExtendedTcpTable(bytes.data(),&size,FALSE,AF_INET,TCP_TABLE_OWNER_PID_ALL,0)!=NO_ERROR) throw std::runtime_error("tcp_table_unavailable");
            auto table=reinterpret_cast<MIB_TCPTABLE_OWNER_PID*>(bytes.data());
            auto port=[](DWORD n){return ((n&255)<<8)|((n>>8)&255);};
            for(DWORD i=0;i<table->dwNumEntries;i++) { auto& r=table->table[i];
                if(r.dwLocalAddr!=0x0100007f || r.dwRemoteAddr!=0x0100007f || port(r.dwLocalPort)!=clientPort || port(r.dwRemotePort)!=serverPort) continue;
                HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,r.dwOwningPid);
                if(!process) throw std::runtime_error("peer_identity_unavailable");
                std::string sid; try {sid=processSid(process);} catch(...) {CloseHandle(process);throw;} CloseHandle(process);
                DWORD session=0; if(!ProcessIdToSessionId(r.dwOwningPid,&session)) throw std::runtime_error("peer_identity_unavailable");
                std::cout<<Json(Json::Object{{"sid",sid},{"windowsSessionId",static_cast<int>(session)},{"pid",static_cast<int>(r.dwOwningPid)}}).dump()<<'\n'; return 0;
            }
            throw std::runtime_error("tcp_peer_not_found");
        }
        if(argc==2 && std::wstring(argv[1])==L"--identity") {
            std::cout<<Json(Json::Object{{"sid",currentSid()},{"windowsSessionId",static_cast<int>(currentSession())}}).dump()<<'\n'; return 0;
        }
        std::string manifest,epoch; DWORD parent=0; bool test=false;
        for(int i=1;i<argc;i++) {
            auto a=std::wstring(argv[i]);
            if(a==L"--test") test=true;
            else if(a==L"--manifest" && i+1<argc) manifest=utf8(argv[++i]);
            else if(a==L"--epoch" && i+1<argc) epoch=utf8(argv[++i]);
            else if(a==L"--parent" && i+1<argc) parent=std::stoul(argv[++i]);
            else throw std::runtime_error("invalid_arguments");
        }
        return hostMain(manifest,epoch,parent,test);
    } catch(const std::exception& e) { std::cerr<<"sdk-host: "<<e.what()<<'\n'; return 70; }
}
