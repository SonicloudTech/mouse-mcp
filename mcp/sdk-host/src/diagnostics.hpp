#pragma once
#include "platform.hpp"
#include "json.hpp"
#include <deque>
#include <condition_variable>
#include <thread>
#include <atomic>

namespace umcp {
// Optional bounded evidence writer. Producers timestamp and enqueue; disk IO runs elsewhere.
class DiagnosticLog {
    HANDLE file=INVALID_HANDLE_VALUE;
    std::mutex mutex; std::condition_variable wake; std::deque<std::string> queue;
    std::thread writer; bool closing=false; size_t total=0; uint64_t sequence=0;
    std::atomic<uint64_t> dropped{0};
public:
    explicit DiagnosticLog(const char* component) {
        wchar_t directory[32768]; DWORD n=GetEnvironmentVariableW(L"UMCP_TRACE_DIR",directory,32768);
        if(!n||n>=32768)return;
        try {
            std::filesystem::path root(directory);
            if(!root.is_absolute()||root.native().rfind(L"\\\\",0)==0)return;
            std::filesystem::create_directories(root);
            auto name=std::string(component)+"-"+std::to_string(GetCurrentProcessId())+"-"+std::to_string(GetTickCount64())+".jsonl";
            file=CreateFileW((root/wide(name)).c_str(),GENERIC_WRITE,FILE_SHARE_READ,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);
            if(file==INVALID_HANDLE_VALUE)return;
            writer=std::thread([this]{run();});
            record("trace.start",{{"component",component}});
        } catch(...) { if(file!=INVALID_HANDLE_VALUE){CloseHandle(file);file=INVALID_HANDLE_VALUE;} }
    }
    void record(const char* stage,Json::Object fields={}) noexcept {
        if(file==INVALID_HANDLE_VALUE)return;
        try {
            FILETIME ft;GetSystemTimePreciseAsFileTime(&ft); ULARGE_INTEGER stamp{};stamp.LowPart=ft.dwLowDateTime;stamp.HighPart=ft.dwHighDateTime;
            LARGE_INTEGER counter,frequency;QueryPerformanceCounter(&counter);QueryPerformanceFrequency(&frequency);
            fields["utcMs"]=static_cast<int64_t>(stamp.QuadPart/10000-11644473600000ULL);
            fields["qpc"]=static_cast<int64_t>(counter.QuadPart);fields["qpcFrequency"]=static_cast<int64_t>(frequency.QuadPart);
            fields["pid"]=static_cast<int>(GetCurrentProcessId());fields["tid"]=static_cast<int>(GetCurrentThreadId());fields["stage"]=stage;
            std::lock_guard<std::mutex> lock(mutex);
            fields["sequence"]=static_cast<int64_t>(++sequence);auto line=Json(std::move(fields)).dump()+"\n";
            if(closing||queue.size()>=8192||line.size()>16384||total+line.size()>32*1024*1024){++dropped;return;}
            total+=line.size();queue.push_back(std::move(line));wake.notify_one();
        }catch(...){++dropped;}
    }
    ~DiagnosticLog(){
        if(file==INVALID_HANDLE_VALUE)return;
        {std::lock_guard<std::mutex> lock(mutex);closing=true;wake.notify_one();}
        if(writer.joinable())writer.join();
        // Emit terminal evidence after draining, including writer failures. Reserve
        // this small record outside the data cap so a full log cannot hide loss.
        try {
            FILETIME ft;GetSystemTimePreciseAsFileTime(&ft);ULARGE_INTEGER stamp{};stamp.LowPart=ft.dwLowDateTime;stamp.HighPart=ft.dwHighDateTime;
            LARGE_INTEGER q,f;QueryPerformanceCounter(&q);QueryPerformanceFrequency(&f);
            auto line=Json(Json::Object{{"stage","trace.stop"},{"pid",static_cast<int>(GetCurrentProcessId())},
                {"utcMs",static_cast<int64_t>(stamp.QuadPart/10000-11644473600000ULL)},
                {"qpc",static_cast<int64_t>(q.QuadPart)},{"qpcFrequency",static_cast<int64_t>(f.QuadPart)},
                {"sequence",static_cast<int64_t>(++sequence)},{"dropped",static_cast<int64_t>(dropped.load())}}).dump()+"\n";
            DWORD written=0;WriteFile(file,line.data(),static_cast<DWORD>(line.size()),&written,nullptr);
        }catch(...){} // Missing terminal record is explicitly incomplete evidence.
        CloseHandle(file);
    }
private:
    void run() noexcept {
        for(;;){std::string line;{std::unique_lock<std::mutex> lock(mutex);wake.wait(lock,[&]{return closing||!queue.empty();});if(queue.empty())return;line=std::move(queue.front());queue.pop_front();}
            DWORD written=0;if(!WriteFile(file,line.data(),static_cast<DWORD>(line.size()),&written,nullptr)||written!=line.size())++dropped;
        }
    }
};
inline std::string traceHex(const uint8_t* data,int n){static const char digits[]="0123456789abcdef";std::string s;for(int i=0;i<n&&i<64;i++){s+=digits[data[i]>>4];s+=digits[data[i]&15];}return s;}
}
