#pragma once
#include "platform.hpp"
#include "hardware_action.hpp"
namespace umcp {
struct PhysicalCoordinates {
    DPI_AWARENESS_CONTEXT old=SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    PhysicalCoordinates(){if(!old)throw std::runtime_error("dpi_context_unavailable");}
    ~PhysicalCoordinates(){if(old)SetThreadDpiAwarenessContext(old);}
};
// Real-mouse window telemetry: identity only, never enforcement. The OS owns
// focus, z-order and hit-testing; target selection belongs to the caller. These
// helpers feed receipts so the agent can verify where input actually landed.
inline Json windowAnnotation(HWND window) {
    if(!window||!IsWindow(window))return Json(Json::Object{{"available",false}});
    DWORD pid=0;GetWindowThreadProcessId(window,&pid);
    Json::Object a{{"available",true},{"pid",static_cast<int64_t>(pid)},
        {"windowId",std::to_string(reinterpret_cast<uintptr_t>(window))},
        {"visible",IsWindowVisible(window)!=0},{"minimized",IsIconic(window)!=0}};
    RECT r{};
    if(GetWindowRect(window,&r))a["rect"]=Json::Object{{"left",static_cast<int>(r.left)},{"top",static_cast<int>(r.top)},
        {"right",static_cast<int>(r.right)},{"bottom",static_cast<int>(r.bottom)}};
    return a;
}
inline Json observeForegroundWindow() { PhysicalCoordinates dpi; return windowAnnotation(GetForegroundWindow()); }
inline Json observeTopmostAt(Point point) {
    PhysicalCoordinates dpi;
    POINT native{point.x,point.y};
    HWND hit=WindowFromPoint(native);
    return hit?windowAnnotation(GetAncestor(hit,GA_ROOT)):Json(Json::Object{{"available",false}});
}
// The optional pid/window_id pair is an intent annotation echoed in receipts.
// Malformed ids still fail fast before any write; whether the referenced window
// currently exists is only reported, never enforced.
inline Json intentAnnotation(const Json& args) {
    Json::Object note{{"provided",false}};
    if(!args.has("window"))return note;
    const auto& target=args.get("window");
    if(!target.object())throw std::runtime_error("invalid_window");
    const auto id=target.text("windowId");
    if(id.empty()||id[0]=='0'||id.size()>20||id.find_first_not_of("0123456789")!=std::string::npos)throw std::runtime_error("invalid_window");
    if(target.has("pid")&&(target.get("pid").integer()<=0||target.get("pid").integer()>UINT32_MAX))throw std::runtime_error("invalid_pid");
    note["provided"]=true;
    if(target.has("pid"))note["pid"]=target.get("pid");
    note["windowId"]=id;
    note["window"]=windowAnnotation(reinterpret_cast<HWND>(static_cast<uintptr_t>(std::stoull(id))));
    return note;
}
}
