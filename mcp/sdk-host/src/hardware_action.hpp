#pragma once
#include "json.hpp"
#include "button_feedback.hpp"
#include <functional>
#include <algorithm>
#include <cmath>
namespace umcp {
struct Point { int x,y; };
struct ActionPort {
    std::function<double()> now;
    std::function<void(int)> sleep;
    std::function<bool()> cancelled,current;
    std::function<Point()> cursor;
    // Real-mouse window telemetry. Optional identity observers; they never gate
    // execution. The OS owns focus, z-order and hit-testing.
    std::function<Json()> observeForeground;
    std::function<Json(Point)> observeTopmost;
    std::function<Json()> intentContext;
    std::function<int(int,int,int,int)> write;
    int doubleClickMs=500;
    std::function<ButtonSnapshot()> buttons;
    std::function<void(const char*,Json::Object)> trace;
    std::function<void()> releasedBaseline;
};
// ---- Positioning model (see POSITIONING.md) -------------------------------
// SDK deltas are HID counts, not desktop pixels. Windows multiplies them by
// a pointer-ballistics gain that depends on command magnitude: measured on
// the reference bench (Enhance Pointer Precision on, speed slider 10/20),
// frames below ~7 counts moved LESS than one pixel per count, the gain
// crossed 1.0 near 7-8 counts and saturated around 2.2-2.5 beyond ~33.
// The curve below is a SEED, never a constant: the plugin re-seeds it for
// the local machine from its pointer settings and every bucket is learned
// online per device, so a different machine or device costs a few extra
// frames, not convergence.
inline constexpr int kGainBuckets=11;
inline constexpr int kGainBucketHi[kGainBuckets]={4,6,8,12,16,24,32,48,64,90,127};
inline constexpr double kGainBucketMid[kGainBuckets]={3.5,5.5,7.5,10.5,14.5,20.5,28.5,40.5,56.5,77.5,109.0};
inline constexpr double kBallisticSeedCurve[kGainBuckets]={0.65,0.80,0.98,1.08,1.15,1.49,1.95,2.14,2.25,2.38,2.30};
inline int gainBucketOf(double magnitude) {
    const int m=static_cast<int>(std::lround(magnitude));
    for(int i=0;i<kGainBuckets;++i) if(m<=kGainBucketHi[i]) return i;
    return kGainBuckets-1;
}
// Piecewise-linear between bucket midpoints: planning iterates on the gain
// and must not oscillate on bucket edges.
inline double curveAt(const double* curve,double magnitude) {
    if(magnitude<=kGainBucketMid[0]) return curve[0];
    for(int i=1;i<kGainBuckets;++i) if(magnitude<=kGainBucketMid[i]) {
        const double f=(magnitude-kGainBucketMid[i-1])/(kGainBucketMid[i]-kGainBucketMid[i-1]);
        return curve[i-1]+(curve[i]-curve[i-1])*f;
    }
    return curve[kGainBuckets-1];
}
// Documented Windows pointer-speed multipliers (slider 1..20; 10 = 1:1).
inline double pointerSpeedMultiplier(int slider) {
    static const double kMultiplier[21]={0,1/32.0,1/16.0,1/8.0,1/4.0,3/8.0,1/2.0,5/8.0,3/4.0,7/8.0,1.0,
        5/4.0,3/2.0,7/4.0,2.0,5/2.0,3.0,7/2.0,4.0,9/2.0,10.0};
    if(slider<1)slider=1; if(slider>20)slider=20;
    return kMultiplier[slider];
}
// Environment seed: flat (gain == slider multiplier at every magnitude) when
// acceleration is off, the measured ballistic shape scaled by the multiplier
// when it is on.
inline void seedGainCurve(bool acceleration,int slider,double* out) {
    const double m=pointerSpeedMultiplier(slider);
    for(int i=0;i<kGainBuckets;++i) out[i]=acceleration?kBallisticSeedCurve[i]*m:m;
}
// Per-device positioning calibration, persisted by the plugin across actions.
// gain[] is the learned px/count per magnitude bucket; seed[] is this
// machine's environment seed and the idle-decay target.
struct PositioningMemory {
    double gain[kGainBuckets];double seed[kGainBuckets];double lastUsedMs=0;
    PositioningMemory(){for(int i=0;i<kGainBuckets;++i)gain[i]=seed[i]=kBallisticSeedCurve[i];}
    static PositioningMemory fromSeed(const double* s){PositioningMemory m;for(int i=0;i<kGainBuckets;++i)m.gain[i]=m.seed[i]=s[i];return m;}
};
// One synchronous native action. Feedback is passive; all input still uses SDK writes.
// Target-button integrity is verified strictly (this is where firmware early-release
// bugs show). Other device buttons, foreign physical buttons and window identity are
// reported in the receipt, never enforced: a real mouse can click anywhere.
inline Json hardwareAction(const Json& a, ActionPort& p, int frameMs=40,int clickMs=50,int feedbackMs=5000, PositioningMemory* memory=nullptr) {
    const double start=p.now(); double end=start;
    int attempted=0,written=0,failed=0,held=0,buttonIndex=0;
    bool releaseNeeded=false,feedbackReady=false,awaitingDown=false;
    bool releaseStateConfirmed=false,requiresButton=false,feedbackReliable=true;
    std::string cleanup="not_needed",error,kind,precision="standard";
    Point final{0,0},target{0,0}; bool observed=false;
    ButtonSnapshot baseline,last,releaseSnapshot; std::array<uint64_t,5> downs{},ups{};
    uint64_t otherDownEdges=0,otherUpEdges=0;
    double pressAt=0,lastDownAt=0;
    auto fail=[](const char* code){throw std::runtime_error(code);};
    auto log=[&](const char* stage,Json::Object fields=Json::Object{}){
        if(!p.trace)return; fields["offsetMs"]=p.now()-start;
        try{p.trace(stage,std::move(fields));}catch(...){} // Diagnostics cannot trigger another input.
    };
    auto safe=[&](auto produce){ try{return produce();}catch(...){return Json();} };
    auto sample=[&]{
        if(!p.buttons)fail("button_feedback_unavailable");
        try{last=p.buttons();}catch(...){feedbackReliable=false;throw;}
        if(!last.healthy){feedbackReliable=false;fail("button_feedback_unavailable");}
        if(last.anomalies!=baseline.anomalies){feedbackReliable=false;fail("button_feedback_anomaly");}
        return last;
    };
    auto buttonsCheck=[&]{
        if(!feedbackReady)return;
        auto s=sample();
        const int watch=requiresButton?buttonIndex:-1;
        // Non-target device buttons are interference telemetry, never failures.
        for(int i=0;i<5;i++) {
            if(i==watch)continue;
            otherDownEdges=std::max<uint64_t>(otherDownEdges,s.downs[i]-downs[i]);
            otherUpEdges=std::max<uint64_t>(otherUpEdges,s.ups[i]-ups[i]);
        }
        if(watch<0)return;
        const uint64_t d=s.downs[watch],u=s.ups[watch];
        if(awaitingDown) {
            if(u>ups[watch])fail(held?"button_released_early":"unexpected_button_edge");
            if(d>downs[watch]+1)fail("unexpected_button_edge");
            if(d==downs[watch]+1) {
                // Queue time -> steady time conversion has Windows timer-tick
                // uncertainty. Edge counters, not this timestamp, detect short pulses.
                if(s.downMs[watch]+20<pressAt)fail("stale_button_feedback");
                ++downs[watch];awaitingDown=false;lastDownAt=s.downMs[watch];
                log("action.press.observed",{{"messageMonoMs",lastDownAt},{"buttons",held}});
            } else if((s.held>>watch)&1)fail("unexpected_button_state");
            return;
        }
        if(d!=downs[watch])fail("unexpected_button_edge");
        const bool bit=((s.held>>watch)&1)!=0,intended=((held>>watch)&1)!=0;
        if(u>ups[watch])fail("button_released_early");
        if(u<ups[watch])fail("unexpected_button_edge");
        if(bit!=intended)fail("unexpected_button_state");
    };
    auto check=[&]{
        if(p.cancelled())fail("cancelled"); if(!p.current())fail("device_changed");
        if(p.now()>=end)fail("deadline_exceeded");
        buttonsCheck();
    };
    auto sleep=[&](int ms){
        const double until=std::min(end,p.now()+ms);
        while(p.now()<until){check();p.sleep(std::max(1,std::min(5,static_cast<int>(std::ceil(until-p.now())))));}
        check();
    };
    auto release=[&]{
        if(!releaseNeeded)return; releaseNeeded=false;
        cleanup="release_unconfirmed";releaseStateConfirmed=false;
        if(!p.current())return;
        // Capture early-up evidence BEFORE the cleanup boundary; preserve its error.
        try{buttonsCheck();}catch(const std::exception& e){if(error.empty())error=e.what();}catch(...){if(error.empty())error="button_feedback_unavailable";}
        if(!p.current())return;
        const double releaseAt=p.now();log("action.release.begin");
        ++attempted;int rc=0;try{rc=p.write(0,0,0,0);}catch(...){}
        if(rc!=1){++failed;return;} ++written;
        // Separate bounded cleanup budget ignores cancellation/focus/deadline, but
        // never writes to a replacement device and never retries the release.
        const double until=p.now()+1000; double quietSince=-1;
        ButtonSnapshot quiet; bool normalUp=false;
        try {
            while(p.now()<until) {
                if(!p.current())return;
                auto s=sample(); bool expected=true;
                if(s.downs[buttonIndex]!=downs[buttonIndex]||s.ups[buttonIndex]!=ups[buttonIndex]+1)expected=false;
                normalUp=expected&&s.upMs[buttonIndex]+20>=releaseAt;
                if(error.empty()&&!normalUp) {
                    bool pending=true;
                    if(s.downs[buttonIndex]!=downs[buttonIndex]||s.ups[buttonIndex]!=ups[buttonIndex])pending=false;
                    if(!pending){error="unexpected_release_edge";log("action.release.edge_invalid");}
                }
                // A prematurely released action can be at rest but remains failed.
                // State confirmation is not attribution of a device ACK to cleanup.
                const bool rest=!((s.held>>buttonIndex)&1)&&s.ups[buttonIndex]>baseline.ups[buttonIndex];
                if(rest) {
                    if(quietSince<0||s.downs[buttonIndex]!=quiet.downs[buttonIndex]||s.ups[buttonIndex]!=quiet.ups[buttonIndex]){quietSince=p.now();quiet=s;}
                    if(p.now()-quietSince>=80) {
                        if(error.empty()&&!normalUp)error="release_feedback_missing";
                        downs=s.downs;ups=s.ups;held=0;awaitingDown=false;
                        releaseStateConfirmed=true;releaseSnapshot=s;cleanup="release_confirmed";
                        log("action.release.confirmed",{{"afterCommandEdge",normalUp},{"quietMs",80}});return;
                    }
                } else quietSince=-1;
                p.sleep(5);
            }
        } catch(const std::exception& e){if(error.empty())error=e.what();}catch(...){if(error.empty())error="button_feedback_unavailable";}
        log("action.release.unconfirmed");
    };
    auto send=[&](int buttons,int dx,int dy,int wheel,bool acquire=false){
        check();if(attempted>=255)fail("frame_limit");
        if(acquire){held=buttons;releaseNeeded=true;awaitingDown=true;releaseStateConfirmed=false;pressAt=p.now();}
        ++attempted;int rc=0;
        try{rc=p.write(buttons,dx,dy,wheel);}catch(...){++failed;fail("write_outcome_unknown");}
        if(rc==1)++written;else{++failed;fail("write_failed");}
        check();
    };
    auto read=[&]{check();final=p.cursor();observed=true;return final;};
    auto position=[&](Point point){
        // SDK deltas are HID counts, not desktop pixels. Gain is a function of
        // command magnitude (pointer ballistics), modelled as a curve over
        // magnitude buckets. Restore the learned curve from device memory
        // (clamped, idle-decayed toward the machine seed) or start from the
        // default ballistic shape when no memory exists.
        const bool highPrecision=precision=="high";
        // Standard mode stops inside 4px. High precision keeps correcting down
        // to 1px; a device whose smallest executable step straddles the target
        // accepts a best-effort stop at 4px (never worse than standard).
        const int tolerance=highPrecision?1:4;
        bool stoppedBelowResolution=false,stallAccepted=false;
        double gain[kGainBuckets];
        if(memory){
            const double ageMs=p.now()-memory->lastUsedMs;
            for(int i=0;i<kGainBuckets;++i){
                double g=memory->gain[i];
                if(ageMs>60000)g=memory->seed[i]+(g-memory->seed[i])*.5;
                gain[i]=std::clamp(g,0.125,10.0);
            }
            Json::Array restored;for(double v:gain)restored.push_back(v);
            log("action.position.gainRestored",{{"curve",Json(restored)},{"ageMs",ageMs},{"precision",precision}});
        } else for(int i=0;i<kGainBuckets;++i)gain[i]=kBallisticSeedCurve[i];
        int bestResidual=1<<30,noProgress=0;
        for(int step=0;step<64;step++) {
            auto here=read();int dx=point.x-here.x,dy=point.y-here.y;
            if(std::abs(dx)<=tolerance&&std::abs(dy)<=tolerance)break;
            // Joint fixed point: both axes share one gain looked up by the
            // vector magnitude of the frame, because ballistics accelerates on
            // vector speed, not per axis.
            int commandX=0,commandY=0;double g=2.0;
            for(int it=0;it<4;++it){
                commandX=std::clamp(static_cast<int>(std::lround(dx*.9/g)),-127,127);
                commandY=std::clamp(static_cast<int>(std::lround(dy*.9/g)),-127,127);
                g=curveAt(gain,std::hypot(static_cast<double>(commandX),static_cast<double>(commandY)));
            }
            // The reference firmware leaves one/two-count moves unexecuted and
            // unreported; such tail corrections stalled for the whole feedback
            // budget. Always move at least three counts on an axis that still
            // needs correction, and never add motion on an axis already inside
            // tolerance.
            if(std::abs(dx)<=tolerance)commandX=0;else if(std::abs(commandX)<3)commandX=dx>0?3:-3;
            if(std::abs(dy)<=tolerance)commandY=0;else if(std::abs(commandY)<3)commandY=dy>0?3:-3;
            if(highPrecision){
                const int residual=std::max(std::abs(dx),std::abs(dy));
                if(residual<=4){
                    // Already standard-grade. Fire one more micro frame only
                    // when the learned curve predicts it lands closer instead
                    // of straddling the target, and stop when progress stalls:
                    // high precision must never be worse than standard.
                    const double magnitude=std::hypot(static_cast<double>(commandX),static_cast<double>(commandY));
                    const double predicted=curveAt(gain,magnitude)*magnitude;
                    if(predicted>residual+3){
                        stallAccepted=true;
                        log("action.position.stall_accepted",{{"residualX",dx},{"residualY",dy},{"predicted",predicted},{"iterations",step}});
                        break;
                    }
                    if(residual<bestResidual){bestResidual=residual;noProgress=0;}
                    else if(++noProgress>=3){
                        stallAccepted=true;
                        log("action.position.stall_accepted",{{"residualX",dx},{"residualY",dy},{"iterations",step}});
                        break;
                    }
                } else {bestResidual=1<<30;noProgress=0;}
            }
            log("action.position.write",{{"iteration",step},{"fromX",here.x},{"fromY",here.y},{"targetX",point.x},{"targetY",point.y},
                {"commandX",commandX},{"commandY",commandY},{"gain",g},{"tol",tolerance}});
            send(held,commandX,commandY,0);
            const double waitStarted=p.now();sleep(std::max(frameMs,30));
            // Frames near the firmware's motion threshold may never be reported.
            // Cap their wait so an unreported micro-move stops fast instead of
            // burning the whole feedback budget; the loop-exit check decides.
            const bool smallFrame=std::abs(commandX)+std::abs(commandY)<=8;
            const double deadline=std::min(end,p.now()+(smallFrame?std::min<double>(feedbackMs,300):feedbackMs));auto latest=read();
            while(latest.x==here.x&&latest.y==here.y&&p.now()<deadline){sleep(20);latest=read();}
            if(latest.x==here.x&&latest.y==here.y){
                if(smallFrame){stoppedBelowResolution=true;log("action.position.subthreshold",{{"commandX",commandX},{"commandY",commandY},{"waitMs",p.now()-waitStarted}});break;}
                fail("feedback_timeout");
            }
            log("action.position.first_feedback",{{"waitMs",p.now()-waitStarted},{"x",latest.x},{"y",latest.y}});
            double quietSince=p.now();
            while(p.now()-quietSince<80&&p.now()<deadline){sleep(20);auto next=read();if(next.x!=latest.x||next.y!=latest.y){latest=next;quietSince=p.now();}}
            if(p.now()-quietSince<80)fail("feedback_unsettled");
            log("action.position.settled",{{"waitMs",p.now()-waitStarted},{"x",latest.x},{"y",latest.y}});
            // Learn the bucket this frame exercised. Trust only movement that
            // agrees with the command direction; keep the observed gain inside
            // the pointer-multiplier envelope and let wild ratios (ballistics
            // speed-history transients, interference) move buckets slowly or
            // not at all.
            const double magnitude=std::hypot(static_cast<double>(commandX),static_cast<double>(commandY));
            if(magnitude>0){
                const double movedX=latest.x-here.x,movedY=latest.y-here.y;
                const double moved=std::hypot(movedX,movedY);
                if(moved>0&&(movedX*commandX+movedY*commandY)>0){
                    const int b=gainBucketOf(magnitude);
                    const double observed=moved/magnitude;
                    if(observed>=0.125&&observed<=10.0){
                        double& current=gain[b];
                        const double blend=std::abs(observed-current)<=std::max(1.0,1.5*current)?.5:.2;
                        current=std::clamp(current+blend*(observed-current),0.125,10.0);
                        if(memory){memory->gain[b]=current;memory->lastUsedMs=p.now();}
                    }
                }
            }
        }
        auto here=read();
        if(std::abs(point.x-here.x)>4||std::abs(point.y-here.y)>4)
            fail(stoppedBelowResolution?"position_below_device_resolution":"position_not_converged");
    };
    Json windowContext{Json::Object{}};
    auto context=[&](const char* key,Json value){ std::get<Json::Object>(windowContext.v)[key]=std::move(value); };
    try {
        kind=a.text("kind");requiresButton=kind=="click"||kind=="drag";
        if(kind!="move"&&kind!="click"&&kind!="drag"&&kind!="scroll")fail("invalid_action");
        precision=a.text("precision","standard");
        if(precision!="standard"&&precision!="high")fail("invalid_precision");
        if(a.has("durationMs"))fail("unsupported_duration");
        end=start+a.number("budgetMs",20000,1,20000);
        target={a.number("x",0,-100000,100000),a.number("y",0,-100000,100000)};
        Point destination{a.number("toX",target.x,-100000,100000),a.number("toY",target.y,-100000,100000)};
        auto button=a.text("button","left");
        if(button!="left"&&button!="right"&&button!="middle")fail("invalid_button");
        buttonIndex=button=="left"?0:button=="right"?1:2;const int bit=1<<buttonIndex;
        const int count=a.number("count",1,1,3);
        int wheel=0;if(kind=="scroll"){auto direction=a.text("direction");if(direction!="up"&&direction!="down")fail("invalid_direction");wheel=a.number("amount",1,1,10)*(direction=="up"?1:-1);}
        if(p.intentContext)context("intent",safe([&]{return p.intentContext();}));
        if(p.observeForeground)context("foregroundAtStart",safe([&]{return p.observeForeground();}));
        baseline=sample();
        if(baseline.anomalies)fail("button_feedback_anomaly");
        // Only the button this action will press must be up: pressing an already
        // held button produces no edge and the click would silently no-op. Other
        // device buttons or foreign physical buttons are reported, not enforced.
        if(requiresButton&&((baseline.held>>buttonIndex)&1))fail("button_target_already_held");
        downs=baseline.downs;ups=baseline.ups;feedbackReady=true;
        log("action.feedback.ready",{{"baselineHeld",baseline.held},{"externalHeld",baseline.globalHeld}});
        sleep(40);
        if(p.releasedBaseline)p.releasedBaseline();
        position(target);
        auto beforePress=[&]{auto here=read();check();if(std::abs(here.x-target.x)>4||std::abs(here.y-target.y)>4)fail("pointer_changed");};
        auto press=[&]{
            if(p.observeTopmost)context("topmostAtPress",safe([&]{return p.observeTopmost(target);}));
            send(bit,0,0,0,true);const double until=std::min(end,p.now()+feedbackMs);
            while(awaitingDown&&p.now()<until)sleep(5);
            if(awaitingDown)fail("button_down_timeout");
        };
        double firstDown=0;
        if(kind=="click")for(int i=0;i<count;i++) {
            if(i){sleep(clickMs*2);if(p.now()-firstDown>=p.doubleClickMs)fail("double_click_timing_exceeded");}
            beforePress();
            // A click can intentionally open another window or popup; the OS owns
            // focus. No window guard interrupts the sequence.
            press();
            if(i&&lastDownAt-firstDown>=p.doubleClickMs)fail("double_click_timing_exceeded");
            if(!i)firstDown=lastDownAt;
            sleep(clickMs);release();if(cleanup!="release_confirmed")fail("release_unconfirmed");if(!error.empty())fail(error.c_str());
        }
        if(kind=="drag"){beforePress();press();sleep(frameMs);target=destination;position(target);}
        if(kind=="scroll"){beforePress();send(0,0,0,wheel);sleep(frameMs);}
        final=read();
    } catch(const std::exception& e){if(error.empty())error=e.what();}catch(...){if(error.empty())error="action_failed";}
    release();
    if(error.empty()) {
        try {
            check();final=p.cursor();observed=true;check();
            if(std::abs(final.x-target.x)>4||std::abs(final.y-target.y)>4)fail("final_position_changed");
        }catch(const std::exception& e){error=e.what();}catch(...){error="final_feedback_unavailable";}
    }
    // Confirmation is a snapshot, not a permanent latch. A late edge, monitor
    // loss, or device replacement invalidates it; do not send another release.
    if(cleanup=="release_confirmed") {
        // Read even after cancellation/focus/deadline failure: those must not skip
        // the final state check that discharges the native held-input obligation.
        try{sample();}catch(...){feedbackReliable=false;}
        if(!feedbackReliable||!p.current()||((last.held>>buttonIndex)&1)
            ||last.downs[buttonIndex]!=releaseSnapshot.downs[buttonIndex]||last.ups[buttonIndex]!=releaseSnapshot.ups[buttonIndex]) {
            cleanup="release_unconfirmed";releaseStateConfirmed=false;
            log("action.release.confirmation_invalidated");
        }
    }
    const std::string actionError=error;
    if(cleanup=="release_unconfirmed")error="release_unconfirmed";
    // Target-button counts are exact for button actions (the firmware early-release
    // regression proof). For movement they summarize every device edge as telemetry.
    uint64_t pressCount=0,releaseCount=0;
    if(requiresButton){ pressCount=last.downs[buttonIndex]-baseline.downs[buttonIndex];releaseCount=last.ups[buttonIndex]-baseline.ups[buttonIndex]; }
    else for(int i=0;i<5;i++) { pressCount+=last.downs[i]-baseline.downs[i];releaseCount+=last.ups[i]-baseline.ups[i]; }
    // A button obligation exists when this action wrote presses, or when a
    // device-attributed edge/held change was seen and never verified back to the
    // baseline state (including feedback lost after any write).
    bool edgesSeen=false,balanced=true;
    for(int i=0;i<5;i++) {
        const auto d=last.downs[i]-baseline.downs[i],u=last.ups[i]-baseline.ups[i];
        if(d||u)edgesSeen=true; if(d!=u)balanced=false;
    }
    const bool verifiedBaseline=feedbackReady&&feedbackReliable&&balanced&&last.held==baseline.held;
    const bool buttonObligation=attempted>0&&(requiresButton||((edgesSeen||last.held!=baseline.held||!feedbackReady||!feedbackReliable)&&!verifiedBaseline));
    if(p.observeTopmost)context("topmostAtFinal",safe([&]{return p.observeTopmost(final);}));
    auto outcome=error.empty()?"completed":attempted||cleanup=="release_unconfirmed"?"indeterminate":error=="cancelled"?"aborted":error=="deadline_exceeded"?"timed_out":"rejected";
    Json::Object result{{"outcome",outcome},{"transport",Json::Object{{"attempted",attempted},{"written",written},{"writeFailed",failed}}},
        {"cleanup",cleanup},{"timing",Json::Object{{"queueMs",0},{"totalMs",p.now()-start}}},{"effectConfirmed",false},
        {"verification",Json::Object{{"schemaVersion",1},{"source","windows-raw-input"},
            {"buttonIntegrity",!feedbackReady?"unavailable":!error.empty()?"failed":requiresButton?"confirmed":"not_required"},
            {"feedbackReliable",feedbackReady&&feedbackReliable},
            {"pressObserved",pressCount>0},{"releaseObserved",releaseCount>0},{"releaseStateConfirmed",releaseStateConfirmed},
            {"observedPresses",static_cast<int64_t>(pressCount)},{"observedReleases",static_cast<int64_t>(releaseCount)},
            {"baselineHeld",baseline.held},{"externalHeld",baseline.globalHeld!=0||last.globalHeld!=0},
            {"deviceHeldAfter",last.held},{"otherEdges",static_cast<int64_t>(otherDownEdges+otherUpEdges)},
            {"buttonObligation",buttonObligation}}},
        {"windowContext",windowContext},
        {"note","Input feedback is not application effect confirmation. Never automatically replay uncertain input."}};
    if(observed){result["final"]=Json::Object{{"x",final.x},{"y",final.y}};result["residual"]=Json::Object{{"dx",target.x-final.x},{"dy",target.y-final.y}};}
    if(!error.empty())result["errorCode"]=error;
    if(!actionError.empty()&&actionError!=error)result["actionErrorCode"]=actionError;
    log("action.complete",result);return result;
}
// An obligation means a press this action wrote, or device-attributed button
// state that was observed changing and never verified back to its baseline.
// Foreign physical interference alone (external/otherEdges) is not an obligation.
inline bool requiresButtonRecovery(const Json& result) {
    if(result.text("cleanup")=="release_confirmed")return false;
    const auto verification=result.get("verification");
    return result.get("transport").get("attempted").integer()>0&&verification.boolean("buttonObligation");
}
}
