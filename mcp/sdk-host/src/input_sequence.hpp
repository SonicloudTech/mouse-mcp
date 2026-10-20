#pragma once
#include "hardware_action.hpp"
#include <set>
namespace umcp {
struct SequencePort {
    std::function<double()> now;
    std::function<void(int)> sleep;
    std::function<bool()> cancelled,current;
    std::function<int(const Json&)> write;
};
// Self-contained HID sequence. The adapter supplies SDK writes; this has no OS input API.
inline Json inputSequence(const Json& a,SequencePort& p) {
    const double start=p.now();double end=start;int attempted=0,written=0,failed=0;
    bool mouseHeld=false,keysHeld=false;std::string error,cleanup="not_needed";
    auto check=[&]{if(p.cancelled())throw std::runtime_error("cancelled");if(!p.current())throw std::runtime_error("device_changed");if(p.now()>=end)throw std::runtime_error("deadline_exceeded");};
    auto send=[&](const Json& f){
        ++attempted;int rc=0;try{rc=p.write(f);}catch(...){++failed;throw std::runtime_error("write_outcome_unknown");}
        if(rc!=1){++failed;throw std::runtime_error("write_failed");}++written;
    };
    try {
        end=start+a.number("budgetMs",20000,100,20000);
        auto& frames=a.get("frames").items();if(frames.empty()||frames.size()>128)throw std::runtime_error("frame_limit");
        int total=0;
        // Validate the entire batch before the first input.
        for(auto& f:frames) {
            if(!f.object())throw std::runtime_error("frame_object_required");
            total+=f.number("delayMs",30,20,100);auto kind=f.text("kind");
            if(kind=="mouse"){f.number("buttons",0,0,7);f.number("dx",0,-127,127);f.number("dy",0,-127,127);f.number("wheel",0,-127,127);}
            else if(kind=="keyboard"){
                f.number("modifiers",0,0,255);auto& keys=f.get("keys").items();if(keys.size()>6)throw std::runtime_error("key_limit");
                std::set<int64_t> seen;for(auto& k:keys){auto n=k.integer();if(n<4||n>231||!seen.insert(n).second)throw std::runtime_error("key_range_or_duplicate");}
            }else throw std::runtime_error("invalid_frame_kind");
        }
        if(total>=end-start)throw std::runtime_error("sequence_budget_too_small");
        for(auto& f:frames) {
            check();const bool mouse=f.text("kind")=="mouse";check();
            bool held=mouse?f.number("buttons",0,0,7)!=0:f.number("modifiers",0,0,255)!=0||!f.get("keys").items().empty();
            // A failed/throwing press still owns a release attempt on the same device epoch.
            if(held){if(mouse)mouseHeld=true;else keysHeld=true;}
            send(f);if(!held){if(mouse)mouseHeld=false;else keysHeld=false;}
            const double until=p.now()+f.number("delayMs",30,20,100);
            while(p.now()<until){check();p.sleep(std::max(1,std::min(5,static_cast<int>(std::ceil(until-p.now())))));}check();
        }
    }catch(const std::exception& e){error=e.what();}catch(...){error="sequence_failed";}
    for(bool mouse:{true,false}) {
        if(!(mouse?mouseHeld:keysHeld))continue;
        if(!p.current()){cleanup="release_unconfirmed";continue;}
        try {
            // Cleanup intentionally ignores focus and cancellation, but never device generation.
            send(mouse?Json(Json::Object{{"kind","mouse"},{"buttons",0},{"dx",0},{"dy",0},{"wheel",0}}):Json(Json::Object{{"kind","keyboard"},{"modifiers",0},{"keys",Json::Array{}}}));
            if(cleanup!="release_unconfirmed")cleanup="release_written";
        }catch(...){cleanup="release_unconfirmed";}
    }
    if(cleanup=="release_unconfirmed")error="release_unconfirmed";
    auto outcome=error.empty()?"completed":attempted||cleanup=="release_unconfirmed"?"indeterminate":error=="cancelled"?"aborted":error=="deadline_exceeded"?"timed_out":"rejected";
    Json::Object r{{"outcome",outcome},{"transport",Json::Object{{"attempted",attempted},{"written",written},{"writeFailed",failed}}},
        {"cleanup",cleanup},{"effectConfirmed",false},{"timing",Json::Object{{"queueMs",0},{"totalMs",p.now()-start}}}};
    if(!error.empty())r["errorCode"]=error;return r;
}
}
