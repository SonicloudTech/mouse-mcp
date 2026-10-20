#pragma once
#include "platform.hpp"
#include "json.hpp"
#include "button_feedback.hpp"
#include <chrono>
#include <cstddef>
#include <cstring>
#include <functional>
#include <limits>
#include <utility>

namespace umcp {
inline bool matchesButtonFeedbackRegistration(const RAWINPUTDEVICE& r,HWND target) {
    // Windows can omit DEVNOTIFY when reading a successful 0x2100 registration
    // back. Accept exactly the two observed representations; do not relax the
    // usage, owning window, INPUTSINK, or exclusion/capture/legacy flags.
    return target&&r.usUsagePage==1&&r.usUsage==2&&r.hwndTarget==target
        &&(r.dwFlags==RIDEV_INPUTSINK||r.dwFlags==(RIDEV_INPUTSINK|RIDEV_DEVNOTIFY));
}
// Passive, action-scoped observation. This class neither opens a HID handle nor
// sends input. Its window belongs to the action thread; snapshot() pumps only
// that window and retains every button edge even when down/up occur between polls.
class RawButtonFeedback {
    using Trace=std::function<void(const char*,Json::Object)>;
    static constexpr UINT maxDevices=1024, maxMessages=8192;
    HWND window=nullptr;
    HINSTANCE instance=GetModuleHandleW(nullptr);
    DWORD threadId=GetCurrentThreadId();
    std::wstring className;
    bool classRegistered=false, registered=false;
    bool constructing=true, baselinePending=true;
    int vendorId=0,productId=0;
    HANDLE device=nullptr;
    std::string devicePath;
    ButtonSnapshot state;
    Trace trace;
    const char* failure=nullptr;

    static double now() {
        return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
    }
    void record(const char* stage,Json::Object fields={}) noexcept {
        try { if(trace){fields["devicePath"]=devicePath;trace(stage,std::move(fields));} } catch(...) {}
    }
    void invalidate(const char* code) noexcept {
        state.healthy=false;
        if(!failure){
            failure=code;
            try { record("input.feedback.invalid",{{"errorCode",code}}); } catch(...) {}
        }
    }
    [[noreturn]] void fail(const char* code) { invalidate(code);throw std::runtime_error(code); }
    static std::vector<RAWINPUTDEVICE> registrations() {
        // The count can change between the two calls. Retry only size races and
        // never interpret an enumeration failure as permission to overwrite it.
        for(int attempt=0;attempt<3;++attempt) {
            UINT count=0;
            if(GetRegisteredRawInputDevices(nullptr,&count,sizeof(RAWINPUTDEVICE))==UINT(-1))
                throw std::runtime_error("button_feedback_registration_query_failed");
            if(count>maxDevices)throw std::runtime_error("button_feedback_registration_limit");
            if(!count)return {};
            std::vector<RAWINPUTDEVICE> result(count);UINT size=count;
            UINT found=GetRegisteredRawInputDevices(result.data(),&size,sizeof(RAWINPUTDEVICE));
            if(found==UINT(-1)) {
                if(GetLastError()==ERROR_INSUFFICIENT_BUFFER)continue;
                throw std::runtime_error("button_feedback_registration_query_failed");
            }
            if(found>count)continue;
            result.resize(found);return result;
        }
        throw std::runtime_error("button_feedback_registration_unstable");
    }
    static bool mouseRegistration(const RAWINPUTDEVICE& r) {
        return r.usUsagePage==1&&(r.usUsage==2||(r.usUsage==0&&(r.dwFlags&RIDEV_PAGEONLY)));
    }
    bool ownsRegistration() const {
        bool found=false;
        for(const auto& r:registrations())if(mouseRegistration(r)) {
            if(found||!matchesButtonFeedbackRegistration(r,window))return false;
            found=true;
        }
        return found;
    }
    static std::vector<RAWINPUTDEVICELIST> devices() {
        for(int attempt=0;attempt<3;++attempt) {
            UINT count=0;
            if(GetRawInputDeviceList(nullptr,&count,sizeof(RAWINPUTDEVICELIST))==UINT(-1))
                throw std::runtime_error("button_feedback_device_query_failed");
            if(count>maxDevices)throw std::runtime_error("button_feedback_device_limit");
            if(!count)return {};
            std::vector<RAWINPUTDEVICELIST> result(count);UINT size=count;
            UINT found=GetRawInputDeviceList(result.data(),&size,sizeof(RAWINPUTDEVICELIST));
            if(found==UINT(-1)) {
                if(GetLastError()==ERROR_INSUFFICIENT_BUFFER)continue;
                throw std::runtime_error("button_feedback_device_query_failed");
            }
            if(found>count)continue;
            result.resize(found);return result;
        }
        throw std::runtime_error("button_feedback_device_list_unstable");
    }
    static std::wstring name(HANDLE h) {
        UINT count=0;
        if(GetRawInputDeviceInfoW(h,RIDI_DEVICENAME,nullptr,&count)==UINT(-1)||!count||count>32768)
            throw std::runtime_error("button_feedback_device_name_failed");
        std::vector<wchar_t> text(static_cast<size_t>(count)+1,0);UINT size=count;
        UINT length=GetRawInputDeviceInfoW(h,RIDI_DEVICENAME,text.data(),&size);
        if(length==UINT(-1)||length>count)throw std::runtime_error("button_feedback_device_name_failed");
        return std::wstring(text.data());
    }
    static std::wstring identifier(const wchar_t* prefix,int value) {
        std::wostringstream s;s<<prefix<<std::hex<<std::setfill(L'0')<<std::setw(4)<<value;return s.str();
    }
    static bool containsToken(const std::wstring& path,const std::wstring& token) {
        auto pos=path.find(token);
        while(pos!=std::wstring::npos) {
            const auto end=pos+token.size();
            if((pos==0||path[pos-1]==L'#'||path[pos-1]==L'&')&&
               (end==path.size()||path[end]==L'#'||path[end]==L'&'))return true;
            pos=path.find(token,pos+1);
        }
        return false;
    }
    std::pair<HANDLE,std::string> selectDevice(int vid,int pid) {
        std::pair<HANDLE,std::string> result{};
        const auto vendor=identifier(L"vid_",vid),product=identifier(L"pid_",pid);
        for(const auto& d:devices())if(d.dwType==RIM_TYPEMOUSE) {
            auto original=name(d.hDevice),lower=original;
            for(auto& c:lower)c=static_cast<wchar_t>(std::towlower(c));
            if(!containsToken(lower,vendor)||!containsToken(lower,product))continue;
            if(result.first)throw std::runtime_error("button_feedback_device_ambiguous");
            result={d.hDevice,utf8(original)};
        }
        if(!result.first)throw std::runtime_error("button_feedback_device_missing");
        return result;
    }
    void inputDesktop() {
        BOOL input=FALSE;
        if(!GetUserObjectInformationW(GetThreadDesktop(threadId),UOI_IO,&input,sizeof(input),nullptr)||!input)
            fail("button_feedback_input_desktop_unavailable");
    }
    void consume(HRAWINPUT handle,DWORD messageTime) {
        UINT size=0;
        if(GetRawInputData(handle,RID_INPUT,nullptr,&size,sizeof(RAWINPUTHEADER))==UINT(-1)||
           size<sizeof(RAWINPUTHEADER)||size>65536) { invalidate("button_feedback_read_failed");return; }
        std::vector<unsigned char> data(size);UINT capacity=size;
        UINT read=GetRawInputData(handle,RID_INPUT,data.data(),&capacity,sizeof(RAWINPUTHEADER));
        if(read==UINT(-1)||read!=size||capacity>size){invalidate("button_feedback_read_failed");return;}
        RAWINPUTHEADER header{};std::memcpy(&header,data.data(),sizeof(header));
        if(header.dwSize!=read){invalidate("button_feedback_packet_invalid");return;}
        if(header.dwType!=RIM_TYPEMOUSE||read<offsetof(RAWINPUT,data)+sizeof(RAWMOUSE)) {
            invalidate("button_feedback_packet_invalid");return;
        }
        RAWMOUSE mouse{};std::memcpy(&mouse,data.data()+offsetof(RAWINPUT,data),sizeof(mouse));
        const USHORT flags=mouse.usButtonFlags;
        if(!(flags&0x03ff))return; // Button edges only; movement and wheel are not recorded here.
        // WM_INPUT's message time is a millisecond Windows queue timestamp, not
        // a USB/device timestamp. Unsigned subtraction handles the 32-bit wrap.
        const DWORD age=static_cast<DWORD>(GetTickCount64())-messageTime;
        if(age>60000){invalidate("button_feedback_message_time_invalid");return;}
        const double eventMs=now()-static_cast<double>(age);
        int downMask=0,upMask=0;
        for(int i=0;i<5;++i) {
            if(flags&(1<<(i*2)))downMask|=1<<i;
            if(flags&(2<<(i*2)))upMask|=1<<i;
        }
        // A short click from a different collection can also fall entirely
        // between global-state polls. It must not be silently mixed into this
        // action, even if the global buttons have already returned to zero.
        if(header.hDevice!=device) {
            ++state.anomalies;
            record("input.feedback.external_button",{{"sourceDevicePath",header.hDevice?utf8(name(header.hDevice)):"unattributed"},
                {"messageTime",static_cast<int64_t>(messageTime)},{"eventMonoMs",eventMs},
                {"timeSource","wm-input-message-time"},{"timeUncertaintyMs",16},
                {"down",downMask},{"up",upMask},{"anomalies",static_cast<int64_t>(state.anomalies)}});
            return;
        }
        // The first caller snapshot is the action baseline. Do not absorb a
        // complete click arriving during construction into an apparently clean
        // baseline simply because its final held state is zero.
        if(baselinePending)++state.anomalies;
        for(int i=0;i<5;++i) {
            const int bit=1<<i;const USHORT down=static_cast<USHORT>(1<<(i*2)),up=static_cast<USHORT>(2<<(i*2));
            if(flags&down) {
                if(state.held&bit)++state.anomalies;
                ++state.downs[i];state.downMs[i]=eventMs;state.held|=bit;
            }
            if(flags&up) {
                if(!(state.held&bit))++state.anomalies;
                ++state.ups[i];state.upMs[i]=eventMs;state.held&=~bit;
            }
            // Two opposite edges in one report have no recoverable ordering.
            if((flags&down)&&(flags&up))++state.anomalies;
        }
        record("input.feedback.button",{{"messageTime",static_cast<int64_t>(messageTime)},
            {"eventMonoMs",eventMs},{"timeSource","wm-input-message-time"},{"timeUncertaintyMs",16},{"down",downMask},{"up",upMask},
            {"held",state.held},{"anomalies",static_cast<int64_t>(state.anomalies)}});
    }
    static LRESULT CALLBACK proc(HWND hwnd,UINT message,WPARAM wp,LPARAM lp) noexcept {
        auto self=reinterpret_cast<RawButtonFeedback*>(GetWindowLongPtrW(hwnd,GWLP_USERDATA));
        if(message==WM_NCCREATE) {
            self=static_cast<RawButtonFeedback*>(reinterpret_cast<CREATESTRUCTW*>(lp)->lpCreateParams);
            SetWindowLongPtrW(hwnd,GWLP_USERDATA,reinterpret_cast<LONG_PTR>(self));
        }
        if(self) {
            try {
                if(message==WM_INPUT)self->consume(reinterpret_cast<HRAWINPUT>(lp),static_cast<DWORD>(GetMessageTime()));
                else if(message==WM_INPUT_DEVICE_CHANGE) {
                    self->record("input.feedback.device_notification",{{"change",static_cast<int64_t>(wp)},
                        {"handle",static_cast<int64_t>(lp)},{"constructing",self->constructing},
                        {"selected",reinterpret_cast<HANDLE>(lp)==self->device}});
                    // Registration itself announces already present devices.
                    // Before the action baseline, accept arrival notifications
                    // only; snapshot() re-enumerates and verifies our binding.
                    // Removal or any notification after baseline remains fatal.
                    if(!self->baselinePending||wp!=GIDC_ARRIVAL)
                        self->invalidate("button_feedback_device_changed");
                }
            } catch(...) { self->invalidate("button_feedback_read_failed"); }
        }
        // In particular, foreground RIM_INPUT requires default cleanup after read.
        return DefWindowProcW(hwnd,message,wp,lp);
    }
    void cleanup() noexcept {
        // The host owns this usage for the scope. Never intentionally remove a
        // replacement registration belonging to another window in this process.
        if(registered&&window) {
            try { if(ownsRegistration()) {
                RAWINPUTDEVICE r{1,2,RIDEV_REMOVE,nullptr};
                if(!RegisterRawInputDevices(&r,1,sizeof(r)))invalidate("button_feedback_unregister_failed");
            } } catch(...) { invalidate("button_feedback_unregister_unconfirmed"); }
        }
        registered=false;
        if(window){SetWindowLongPtrW(window,GWLP_USERDATA,0);DestroyWindow(window);window=nullptr;}
        if(classRegistered){UnregisterClassW(className.c_str(),instance);classRegistered=false;}
    }
public:
    RawButtonFeedback(int vid,int pid,Trace callback):vendorId(vid),productId(pid),trace(std::move(callback)) {
        try {
            if(vid<=0||vid>65535||pid<=0||pid>65535)fail("button_feedback_invalid_identity");
            inputDesktop();
            for(const auto& r:registrations())if(mouseRegistration(r))fail("button_feedback_registration_conflict");
            auto selected=selectDevice(vid,pid);device=selected.first;devicePath=std::move(selected.second);
            className=L"uMouse.ButtonFeedback."+std::to_wstring(GetCurrentProcessId())+L"."+
                std::to_wstring(threadId)+L"."+std::to_wstring(reinterpret_cast<uintptr_t>(this));
            WNDCLASSW c{};c.lpfnWndProc=proc;c.hInstance=instance;c.lpszClassName=className.c_str();
            if(!RegisterClassW(&c))fail("button_feedback_window_class_failed");
            classRegistered=true;
            window=CreateWindowExW(0,className.c_str(),L"uMouse passive button feedback",0,0,0,0,0,HWND_MESSAGE,nullptr,instance,this);
            if(!window)fail("button_feedback_window_failed");
            // Recheck after window creation, which can dispatch messages.
            for(const auto& r:registrations())if(mouseRegistration(r))fail("button_feedback_registration_conflict");
            RAWINPUTDEVICE r{1,2,RIDEV_INPUTSINK|RIDEV_DEVNOTIFY,window};
            if(!RegisterRawInputDevices(&r,1,sizeof(r)))fail("button_feedback_register_failed");
            registered=true;
            selected=selectDevice(vid,pid);
            if(selected.first!=device||selected.second!=devicePath)fail("button_feedback_device_changed");
            snapshot();
            constructing=false;
        } catch(const std::exception& e) {
            try { record("input.feedback.bind_failed",{{"errorCode",e.what()}}); } catch(...) {}
            cleanup();throw;
        } catch(...) { cleanup();throw; }
    }
    ~RawButtonFeedback(){cleanup();}
    RawButtonFeedback(const RawButtonFeedback&)=delete;
    RawButtonFeedback& operator=(const RawButtonFeedback&)=delete;
    std::string path() const {return devicePath;}
    ButtonSnapshot snapshot() {
        try {
            if(GetCurrentThreadId()!=threadId)fail("button_feedback_wrong_thread");
            if(failure)throw std::runtime_error(failure);
            inputDesktop();
            if(!window||!IsWindow(window)||GetWindowLongPtrW(window,GWLP_USERDATA)!=reinterpret_cast<LONG_PTR>(this)||!ownsRegistration())
                fail("button_feedback_registration_changed");
            MSG message{};UINT count=0;
            while(PeekMessageW(&message,window,0,0,PM_REMOVE)) {
                if(message.message==WM_QUIT) {
                    // PeekMessage can retrieve thread WM_QUIT despite an HWND filter.
                    PostQuitMessage(static_cast<int>(message.wParam));fail("button_feedback_thread_quit");
                }
                DispatchMessageW(&message);
                if(failure)throw std::runtime_error(failure);
                if(++count>=maxMessages)fail("button_feedback_message_limit");
            }
            inputDesktop();
            if(!ownsRegistration())fail("button_feedback_registration_changed");
            if(baselinePending) {
                auto selected=selectDevice(vendorId,productId);
                if(selected.first!=device||selected.second!=devicePath)fail("button_feedback_device_changed");
            }
            const int keys[]{VK_LBUTTON,VK_RBUTTON,VK_MBUTTON,VK_XBUTTON1,VK_XBUTTON2};
            state.globalHeld=0;
            for(int i=0;i<5;++i)if(GetAsyncKeyState(keys[i])&0x8000)state.globalHeld|=1<<i;
            if(!constructing)baselinePending=false;
            return state;
        } catch(...) {
            // A transient enumeration/read failure cannot disappear on the next
            // poll and retroactively turn this action's incomplete evidence valid.
            if(!failure)invalidate("button_feedback_snapshot_failed");
            throw;
        }
    }
};
}
