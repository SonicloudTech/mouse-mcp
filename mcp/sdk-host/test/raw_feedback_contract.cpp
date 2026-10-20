#include "raw_button_feedback.hpp"
#include <iostream>

using namespace umcp;
namespace {
void require(bool condition,const char* detail) { if(!condition)throw std::runtime_error(detail); }
void output(const char* stage,Json::Object fields={}) {
    FILETIME ft{};GetSystemTimePreciseAsFileTime(&ft);ULARGE_INTEGER utc{};utc.LowPart=ft.dwLowDateTime;utc.HighPart=ft.dwHighDateTime;
    LARGE_INTEGER counter{},frequency{};QueryPerformanceCounter(&counter);QueryPerformanceFrequency(&frequency);
    fields["utcMs"]=static_cast<int64_t>(utc.QuadPart/10000-11644473600000ULL);
    fields["qpc"]=static_cast<int64_t>(counter.QuadPart);fields["qpcFrequency"]=static_cast<int64_t>(frequency.QuadPart);
    fields["pid"]=static_cast<int>(GetCurrentProcessId());fields["stage"]=stage;
    std::cout<<Json(std::move(fields)).dump()<<'\n';
}
std::vector<RAWINPUTDEVICE> registrations() {
    for(int attempt=0;attempt<3;++attempt) {
        UINT count=0;SetLastError(ERROR_SUCCESS);
        UINT result=GetRegisteredRawInputDevices(nullptr,&count,sizeof(RAWINPUTDEVICE));
        if(result==UINT(-1)&&GetLastError()!=ERROR_INSUFFICIENT_BUFFER)throw std::runtime_error("registration_count_failed");
        if(count>1024)throw std::runtime_error("registration_count_limit");
        if(!count)return {};
        std::vector<RAWINPUTDEVICE> list(count);UINT size=count;
        result=GetRegisteredRawInputDevices(list.data(),&size,sizeof(RAWINPUTDEVICE));
        if(result==UINT(-1)) {
            if(GetLastError()==ERROR_INSUFFICIENT_BUFFER)continue;
            throw std::runtime_error("registration_read_failed");
        }
        if(result>count)continue;
        list.resize(result);return list;
    }
    throw std::runtime_error("registration_list_unstable");
}
void predicateCases() {
    const auto target=reinterpret_cast<HWND>(static_cast<uintptr_t>(0x1234));
    const auto other=reinterpret_cast<HWND>(static_cast<uintptr_t>(0x5678));
    int cases=0;
    auto check=[&](RAWINPUTDEVICE r,HWND wanted,bool expected,const char* detail){
        require(matchesButtonFeedbackRegistration(r,wanted)==expected,detail);++cases;
    };
    for(DWORD flags:{DWORD(RIDEV_INPUTSINK),DWORD(RIDEV_INPUTSINK|RIDEV_DEVNOTIFY)}) {
        check({1,2,flags,target},target,true,"supported flag readback rejected");
        check({1,2,flags,other},target,false,"another window accepted");
        check({1,2,flags,nullptr},target,false,"null registered window accepted");
        check({1,2,flags,target},nullptr,false,"null expected window accepted");
        check({1,2,flags,nullptr},nullptr,false,"two null windows accepted");
        check({2,2,flags,target},target,false,"wrong usage page accepted");
        check({1,6,flags,target},target,false,"keyboard usage accepted");
        check({1,0,flags,target},target,false,"page-wide registration accepted");
    }
    for(DWORD flags:{DWORD(0),DWORD(RIDEV_DEVNOTIFY),DWORD(RIDEV_EXINPUTSINK),DWORD(RIDEV_INPUTSINK|RIDEV_NOLEGACY),
        DWORD(RIDEV_INPUTSINK|RIDEV_CAPTUREMOUSE),DWORD(RIDEV_INPUTSINK|RIDEV_REMOVE),DWORD(RIDEV_INPUTSINK|RIDEV_PAGEONLY),DWORD(RIDEV_INPUTSINK|0x80000000UL)})
        check({1,2,flags,target},target,false,"unsupported or missing input-sink flags accepted");
    output("predicate.complete",{{"fakeOnly",true},{"cases",cases},{"realRegistration",false},{"sdkLoaded",false},{"inputInjection",false}});
}
void liveReadonly() {
    // Explicit manual-only opt-in. No SDK initialization, HID access, mouse or
    // keyboard injection, foreground activation, or device commands occur here.
    output("live.begin",{{"passiveOnly",true},{"sdkLoaded",false},{"inputInjection",false}});
    for(const auto& r:registrations())require(!(r.usUsagePage==1&&r.usUsage==2),"existing mouse subscription in this process");
    HWND owned=nullptr;
    {
        RawButtonFeedback monitor(0xABC9,0xCA89,[](const char* stage,Json::Object fields){output(stage,std::move(fields));});
        auto state=monitor.snapshot();
        require(state.healthy,"live feedback unhealthy");
        require(state.anomalies==0&&state.held==0&&state.globalHeld==0,"live baseline requires idle buttons");
        for(const auto& r:registrations())if(r.usUsagePage==1&&r.usUsage==2) {
            require(!owned,"multiple mouse subscriptions");owned=r.hwndTarget;
            require(matchesButtonFeedbackRegistration(r,owned),"live registration does not match owned window");
            output("live.registration",{{"hwnd",static_cast<int64_t>(reinterpret_cast<uintptr_t>(owned))},
                {"flags",static_cast<int64_t>(r.dwFlags)},{"devicePath",monitor.path()}});
        }
        require(owned!=nullptr,"live mouse registration missing");
        output("live.snapshot",{{"healthy",state.healthy},{"held",state.held},{"globalHeld",state.globalHeld},
            {"anomalies",static_cast<int64_t>(state.anomalies)}});
    }
    const auto remaining=registrations();
    for(const auto& r:remaining)require(!(r.usUsagePage==1&&r.usUsage==2),"destroyed monitor left a mouse subscription");
    output("live.complete",{{"passiveOnly",true},{"registrationRemoved",true},{"remainingRegistrations",static_cast<int>(remaining.size())}});
}
}
int main(int argc,char** argv) {
    try {
        if(argc==1)predicateCases();
        else if(argc==2&&std::string(argv[1])=="--live-readonly")liveReadonly();
        else throw std::runtime_error("usage: umcp-raw-feedback-contract [--live-readonly]");
        return 0;
    }catch(const std::exception& e){output("failure",{{"error",e.what()}});return 1;}
}
