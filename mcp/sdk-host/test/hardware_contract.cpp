#include "hardware_action.hpp"
#include <iostream>
using namespace umcp;
int main(int argc,char** argv) {
    try {
        std::string name=argc>1?argv[1]:"";double clock=0,firstPressAt=-1,repressAt=-1,lastReleaseAt=-1;Point cursor{10,20};
        bool cancelled=false,current=true,focusLost=false,repressed=false,deadlineInjected=false,lateInjected=false;ButtonSnapshot feedback;
        std::vector<Json> frames;int reads=0,pressWrites=0,heldMoves=0,releaseWrites=0,minXReached=0;
        auto edge=[&](int state,double at){
            for(int i=0;i<5;++i){const int bit=1<<i;
                if((state&bit)&&!(feedback.held&bit)){++feedback.downs[i];feedback.downMs[i]=at;}
                if(!(state&bit)&&(feedback.held&bit)){++feedback.ups[i];feedback.upMs[i]=at;}
            }
            feedback.held=state;feedback.globalHeld=state;
        };
        auto advance=[&](int ms){
            clock+=ms;
            if((name=="cancel-drag"||name=="device-change-during-release-snapshot")&&!frames.empty())cancelled=true;
            if(name=="deadline-drag"&&!frames.empty()&&!deadlineInjected){clock=2001;deadlineInjected=true;}
            if(name=="focus-while-waiting"&&firstPressAt>=0&&clock>=firstPressAt+5)focusLost=true;
            if(name=="release-repress"&&repressAt>=0&&!repressed&&clock>=repressAt){edge(1,repressAt);repressed=true;}
        };
        ActionPort p;int releasedBaselines=0;
        p.releasedBaseline=[&]{++releasedBaselines;};
        p.now=[&]{return clock;};p.sleep=advance;p.cancelled=[&]{return cancelled;};p.current=[&]{return current;};
        p.cursor=[&]{
            if(++reads==2&&name=="cancel-before-down")cancelled=true;
            if(lastReleaseAt>=0&&clock>=lastReleaseAt+80&&!lateInjected){
                lateInjected=true;
                if(name=="final-late-down")edge(1,clock);
                if(name=="final-feedback-loss")feedback.healthy=false;
                if(name=="final-device-change")current=false;
                if(name=="final-position-drift")cursor.x+=10;
            }
            return cursor;
        };
        p.buttons=[&]{
            // The monitor consumed a down, then failed before returning this
            // snapshot. The action must not equate missing counters with release.
            if(name=="move-feedback-throws"&&!frames.empty())throw std::runtime_error("button_feedback_read_failed");
            // Cancellation starts cleanup while current() is still true. The
            // feedback read discovers replacement before the release write.
            if(name=="device-change-during-release-snapshot"&&cancelled&&pressWrites>0&&releaseWrites==0)current=false;
            return feedback;
        };
        p.write=[&](int b,int dx,int dy,int w){
            frames.push_back(Json::Object{{"b",b},{"dx",dx},{"dy",dy},{"w",w},{"atMs",clock}});
            const bool press=b&&dx==0&&dy==0&&w==0,release=!b&&dx==0&&dy==0&&w==0;
            if(press){++pressWrites;if(firstPressAt<0)firstPressAt=clock;}
            if(release){++releaseWrites;lastReleaseAt=clock;}
            if(name=="disconnect"&&b)current=false;
            if(name=="release-fails"&&release)return 0;
            if(name=="write-throws"&&press)throw std::runtime_error("fixture_unknown_write");
            if(name=="write-fails"&&press)return 0;
            if(name=="delayed-second-down"&&press&&pressWrites==2)clock+=600;
            if(!(press&&(name=="press-no-feedback"||name=="focus-while-waiting"))&&!(release&&name=="release-no-up"))edge(b,clock);
            // Keep actual down time while the SDK transport call returns late.
            if(name=="slow-double"&&press)clock+=600;
            if(name=="pulse-down-up"&&press){clock+=1;edge(0,clock);}
            if(name=="pulse-down-up-down"&&press){clock+=1;edge(0,clock);clock+=1;edge(b,clock);}
            if(name=="stale-down"&&press)feedback.downMs[0]=clock-30;
            if(name=="feedback-unhealthy"&&press)feedback.healthy=false;
            if(name=="feedback-anomaly"&&press)++feedback.anomalies;
            if((name=="click-opens-window"||name=="double-second-occluded")&&press)focusLost=true;
            if(name=="click-up-opens-window"&&release)focusLost=true;
            if(name=="move-unexpected-right"&&(dx||dy))edge(2,clock);
            if(name=="move-feedback-throws"&&(dx||dy))edge(1,clock);
            if(name=="move-feedback-unhealthy"&&(dx||dy))feedback.healthy=false;
            if(b&&(dx||dy)){
                ++heldMoves;
                if(name=="early-up-drag"&&heldMoves==1){clock+=1;edge(0,clock);}
                if(name=="drag-focus-loss"&&heldMoves==1)focusLost=true;
            }
            if(release&&name=="release-repress")repressAt=clock+20;
            if(release&&name=="release-feedback-unhealthy")feedback.healthy=false;
            if(name!="no-feedback"&&!(name=="micro-stall"&&std::abs(dx)+std::abs(dy)<=8)){
                double gx=1,gy=1;
                if(name=="move-scaled"||name=="drag-scaled"||name=="precision-gate")gx=gy=2.57;
                if(name=="seed-flat")gx=gy=0.3;
                if(name=="move-nonlinear"){gx=std::abs(dx)<10?0.5:2.57;gy=1.4;}
                if(name=="move-slow-long")gx=gy=0.5;
                if(name=="move-quantized"){
                    auto scaled=[&](int d){
                        const double gain=frames.size()<=2?4.51:std::abs(d)>64?2.5:std::abs(d)>32?2.2:std::abs(d)>16?1.8:std::abs(d)>8?1.1:std::abs(d)>4?0.8:0.55;
                        return static_cast<int>(d*gain); // One HID count may produce zero whole pixels.
                    };
                    cursor.x+=scaled(dx);cursor.y+=scaled(dy);
                } else if(name=="gain-memory"){
                    // Curve-shaped device 1.4x hotter than the default seed at
                    // every magnitude: the memory must retain the learned curve.
                    const double mag=std::hypot(static_cast<double>(dx),static_cast<double>(dy));
                    const double g=curveAt(kBallisticSeedCurve,mag)*1.4;
                    cursor.x+=static_cast<int>(std::lround(dx*g));cursor.y+=static_cast<int>(std::lround(dy*g));
                } else if(name=="precision-stall"){
                    // Small frames have a 5px execution quantum regardless of
                    // the commanded magnitude.
                    if(std::abs(dx)+std::abs(dy)<=8){cursor.x+=dx>0?5:dx<0?-5:0;cursor.y+=dy>0?5:dy<0?-5:0;}
                    else {cursor.x+=dx;cursor.y+=dy;}
                } else {cursor.x+=static_cast<int>(std::round(dx*gx));cursor.y+=static_cast<int>(std::round(dy*gy));}
                if(name=="gain-memory")minXReached=std::min(minXReached,cursor.x);
            }
            return 1;
        };
        // Intermediate cursor position is not convergence while motion continues.
        if(name=="motion-tail")p.cursor=[&]{if(!frames.empty())cursor.x=clock>=70?18:13;return cursor;};
        Json::Object a{{"kind","click"},{"x",10},{"y",20},{"budgetMs",2000}};
        if(name=="move"||name=="no-feedback"||name=="target-change"||name=="move-unexpected-right"||name=="move-feedback-throws"||name=="move-feedback-unhealthy"){a["kind"]="move";a["x"]=400;}
        if(name=="motion-tail"){a["kind"]="move";a["x"]=13;cursor.x=0;}
        if(name=="double"||name=="slow-double"||name=="delayed-second-down"||name=="double-second-occluded")a["count"]=2;
        if(name=="drag"||name=="cancel-drag"||name=="deadline-drag"||name=="disconnect"||name=="release-fails"||name=="early-up-drag"||name=="focus-while-waiting"||name=="drag-focus-loss"){
            a["kind"]="drag";a["toX"]=100;a["toY"]=100;
        }
        if(name=="scroll"){a["kind"]="scroll";a["direction"]="down";a["amount"]=3;}
        if(name=="invalid-duration")a["durationMs"]=100;
        if(name=="cancel-before")cancelled=true;
        if(name=="baseline-held")feedback.held=feedback.globalHeld=1;
        if(name=="baseline-external-held")feedback.globalHeld=2;
        if(name=="feedback-missing")p.buttons={};
        if(name=="actual-press-occluded")cursor.x=12;
        const bool scaledMove=name=="move-scaled"||name=="move-nonlinear"||name=="move-slow-long"||name=="move-quantized";
        if(scaledMove){a["kind"]="move";a["x"]=328;a["y"]=426;a["budgetMs"]=20000;cursor={2854,1030};}
        if(name=="drag-scaled"){a["kind"]="drag";a["toX"]=590;a["toY"]=20;a["budgetMs"]=20000;}
        if(name=="tolerance-4"){a["kind"]="move";a["x"]=14;}
        if(name=="micro-stall"){a["kind"]="move";a["x"]=50;cursor.x=45;}
        if(name=="gain-memory"){a["kind"]="move";a["x"]=400;a["y"]=100;a["budgetMs"]=20000;cursor={500,100};minXReached=500;}
        if(name=="precision-high"){a["kind"]="move";a["x"]=14;a["precision"]="high";}
        if(name=="precision-gate"){a["kind"]="move";a["x"]=14;a["precision"]="high";}
        if(name=="precision-stall"){a["kind"]="move";a["x"]=13;a["precision"]="high";}
        if(name=="seed-flat"){a["kind"]="move";a["x"]=410;a["budgetMs"]=20000;}
        if(name=="seed-curve"){a["kind"]="move";a["x"]=400;}
        // A first run seeds the memory from its own cold start (its first frame
        // overshoots past the target); the measured action below must reuse the
        // learned curve instead of restarting from the default seed.
        PositioningMemory sharedMemory,gateMemory,flatMemory;int firstRunMinX=0;
        if(name=="precision-gate"){double s[kGainBuckets];for(int i=0;i<kGainBuckets;++i)s[i]=2.57;gateMemory=PositioningMemory::fromSeed(s);}
        if(name=="gain-memory") {
            hardwareAction(a,p,40,50,100,&sharedMemory);
            firstRunMinX=minXReached;minXReached=500;
            cursor={500,100};frames.clear();reads=0;pressWrites=0;heldMoves=0;releaseWrites=0;
        }
        // A first run blends each magnitude bucket once toward the flat 0.3
        // gain; the measured action below must continue from that memory.
        if(name=="seed-flat") {
            hardwareAction(a,p,40,50,5000,&flatMemory);
            cursor={10,20};frames.clear();reads=0;
        }
        auto result=hardwareAction(a,p,40,50,name=="micro-stall"||name=="seed-flat"?5000:100,
            name=="gain-memory"?&sharedMemory:name=="precision-gate"?&gateMemory:name=="seed-flat"?&flatMemory:nullptr);auto outcome=result.text("outcome");
        auto require=[&](bool ok,const char* message){if(!ok){std::cerr<<Json(Json::Object{{"case",name},{"receipt",result},{"frames",Json::Array(frames)},{"fakeOnly",true}}).dump()<<'\n';throw std::runtime_error(message);}};
        const auto v=result.get("verification");
        // Real-mouse semantics: window identity (occlusion, focus, target change)
        // never fails an action; foreign held buttons are telemetry.
        const bool success=scaledMove||name=="drag-scaled"||name=="move"||name=="click"||name=="double"||name=="drag"||name=="scroll"
            ||name=="click-opens-window"||name=="click-up-opens-window"||name=="occluded"||name=="actual-press-occluded"
            ||name=="target-change"||name=="double-second-occluded"||name=="drag-focus-loss"||name=="baseline-external-held"
            ||name=="move-unexpected-right"||name=="gain-memory"||name=="tolerance-4"||name=="precision-high"||name=="precision-gate"
            ||name=="precision-stall"||name=="seed-flat"||name=="seed-curve";
        require((outcome=="completed")==success,"wrong completion outcome");
        require(!result.boolean("effectConfirmed"),"input receipt asserted application effect");
        require(v.get("schemaVersion").integer()==1&&v.text("source")=="windows-raw-input","missing feedback contract");
        if(success)require(v.boolean("feedbackReliable"),"completed action without reliable feedback");
        if(scaledMove||name=="drag-scaled"){
            auto residual=result.get("residual");
            require(std::abs(residual.get("dx").integer())<=4&&std::abs(residual.get("dy").integer())<=4,"scaled movement missed tolerance");
            require(frames.size()<64&&clock<20000,"scaled movement exceeded bounded convergence");
            if(scaledMove)require(pressWrites==0&&releaseWrites==0,"movement added button commands");
            else require(pressWrites==1&&releaseWrites==1&&heldMoves>0&&result.text("cleanup")=="release_confirmed","scaled drag lost held state or replayed press");
        }
        if(name=="gain-memory"){
            auto residual=result.get("residual");
            require(firstRunMinX<396,"cold-start run must overshoot (documents why memory is kept)");
            require(minXReached>=378&&minXReached>firstRunMinX,"remembered curve must land the first frame closer than cold start");
            const double remembered=sharedMemory.gain[gainBucketOf(38.0)];
            require(remembered>2.5&&remembered<3.4,"curve memory did not retain the learned bucket");
            require(std::abs(residual.get("dx").integer())<=4&&std::abs(residual.get("dy").integer())<=4,"gain memory missed tolerance");
        }
        if(name=="tolerance-4")require(outcome=="completed"&&frames.empty()&&result.text("cleanup")=="not_needed","4px residual must stop without correction frames");
        if(name=="micro-stall")require(outcome=="indeterminate"&&result.text("errorCode")=="position_below_device_resolution"
            &&frames.size()==1&&clock<600,"unreported micro frame must stop fast with a resolution error, not a budget timeout");
        if(name=="precision-high"){
            auto residual=result.get("residual");
            require(outcome=="completed"&&frames.size()==1,"high precision must converge in one micro frame on a 1:1 device");
            require(std::abs(residual.get("dx").integer())<=1,"high precision missed the 1px tolerance");
        }
        if(name=="precision-gate")
            require(outcome=="completed"&&frames.empty(),"predicted straddling micro frame must be withheld");
        if(name=="precision-stall"){
            auto residual=result.get("residual");
            require(outcome=="completed"&&frames.size()>=4&&frames.size()<=6,"stalling micro corrections must stop after bounded frames");
            require(std::abs(residual.get("dx").integer())<=4,"stall acceptance must stay inside standard tolerance");
        }
        if(name=="seed-flat"){
            auto residual=result.get("residual");
            require(outcome=="completed"&&std::abs(residual.get("dx").integer())<=4&&std::abs(residual.get("dy").integer())<=4,"flat low-gain environment missed tolerance");
            require(frames.size()>=2&&frames.size()<64,"flat low-gain environment must converge in bounded frames");
            const double lowest=*std::min_element(flatMemory.gain,flatMemory.gain+kGainBuckets);
            require(lowest<0.5,"wide clamp must let sub-0.5 gains be learned");
            require(flatMemory.gain[gainBucketOf(120.0)]<2.0,"learning must pull the large-magnitude bucket below its seed");
        }
        if(name=="seed-curve"){
            double flat1[kGainBuckets],flat5[kGainBuckets],acc[kGainBuckets];
            seedGainCurve(false,10,flat1);seedGainCurve(false,5,flat5);seedGainCurve(true,10,acc);
            require(std::abs(pointerSpeedMultiplier(10)-1.0)<1e-9&&std::abs(pointerSpeedMultiplier(20)-10.0)<1e-9
                &&std::abs(pointerSpeedMultiplier(1)-1.0/32.0)<1e-9,"pointer speed multiplier table");
            bool curves=true;
            for(int i=0;i<kGainBuckets;++i)if(std::abs(flat1[i]-1.0)>1e-9||std::abs(acc[i]-kBallisticSeedCurve[i])>1e-9)curves=false;
            require(curves&&std::abs(flat5[0]-0.375)<1e-9,"environment seed curves");
        }
        require(v.boolean("pressObserved")==(v.get("observedPresses").integer()>0),"press flag/count mismatch");
        require(v.boolean("releaseObserved")==(v.get("observedReleases").integer()>0),"release flag/count mismatch");
        if(name=="click"||name=="double"||name=="drag"||name=="click-opens-window"||name=="click-up-opens-window"
            ||name=="double-second-occluded"||name=="drag-focus-loss"||name=="baseline-external-held"||name=="actual-press-occluded"||name=="occluded"){
            const int count=(name=="double"||name=="double-second-occluded")?2:1;
            require(v.text("buttonIntegrity")=="confirmed"&&v.get("observedPresses").integer()==count&&v.get("observedReleases").integer()==count,"success requires exact observed pairs");
            require(result.text("cleanup")=="release_confirmed"&&v.boolean("releaseStateConfirmed"),"success requires release state confirmation");
            require(pressWrites==count&&releaseWrites==count,"extra down/up commands");
        }
        if(name=="move"||name=="scroll"||name=="target-change"||name=="move-unexpected-right"||name=="tolerance-4"
            ||name=="precision-high"||name=="precision-gate"||name=="precision-stall"||name=="seed-flat"||name=="seed-curve")
            require(v.text("buttonIntegrity")=="not_required"&&result.text("cleanup")=="not_needed"&&pressWrites==0&&releaseWrites==0,"button proof invented for movement");
        if(name=="click")require(frames.size()==2,"click must be down/up exactly");
        if(name=="double")require(frames.size()==4,"double must be two down/up pairs");
        if(name=="slow-double")require(pressWrites==1&&result.text("errorCode")=="double_click_timing_exceeded","late second click must not be sent");
        if(name=="delayed-second-down")require(pressWrites==2&&releaseWrites==2&&result.text("errorCode")=="double_click_timing_exceeded","late observed second down must not pass");
        if(name=="drag")require(heldMoves>0&&frames.back().get("b").integer()==0,"drag must retain held state and release");
        if(name=="cancel-drag"||name=="deadline-drag")require(frames.size()==2&&result.text("cleanup")=="release_confirmed","cancellation/deadline must execute one verified release");
        if(name=="disconnect")require(frames.size()==1&&result.text("cleanup")=="release_unconfirmed","do not release to replacement generation");
        if(name=="device-change-during-release-snapshot")require(frames.size()==1&&pressWrites==1&&releaseWrites==0&&!current&&result.text("cleanup")=="release_unconfirmed","device changed during cleanup snapshot but still received release");
        if(name=="double-second-occluded")require(frames.size()==4&&pressWrites==2&&releaseWrites==2,"second click after focus change must proceed like a real mouse");
        if(name=="actual-press-occluded")require(frames.size()==2&&pressWrites==1&&releaseWrites==1,"in-tolerance cursor under another window must still click");
        if(name=="drag-focus-loss")require(pressWrites==1&&heldMoves>=1&&releaseWrites==1,"drag focus loss must not interrupt the drag");
        if(name=="release-fails"||name=="release-no-up"||name=="release-repress"||name=="release-feedback-unhealthy")require(result.text("cleanup")=="release_unconfirmed"&&releaseWrites==1,"write success alone or unstable state cannot confirm cleanup");
        if(name=="release-no-up")require(v.get("observedReleases").integer()==0&&!v.boolean("releaseStateConfirmed"),"missing up report called released");
        if(name=="release-repress")require(v.get("observedPresses").integer()==2&&!v.boolean("releaseStateConfirmed"),"repress during quiet interval ignored");
        if(name=="invalid-duration"||name=="cancel-before"||name=="cancel-before-down"||name=="baseline-held"||name=="feedback-missing")require(frames.empty(),"rejected preflight wrote input");
        if(name=="no-feedback")require(frames.size()==1&&pressWrites==0&&releasedBaselines==1,"feedback timeout must not spam movement or click");
        if(name=="baseline-held")require(result.text("errorCode")=="button_target_already_held"&&releasedBaselines==0,"pressing an already held target button must fail fast");
        if(name=="baseline-external-held")require(frames.size()==2&&releasedBaselines==1&&v.boolean("externalHeld")&&v.get("baselineHeld").integer()==0,"foreign held buttons must not block the click");
        if(name=="move-unexpected-right")require(frames.size()>=4&&frames.size()<=8&&releaseWrites==0
            &&v.get("otherEdges").integer()==static_cast<int64_t>(frames.size()*2-1)&&v.get("observedPresses").integer()==static_cast<int64_t>(frames.size())
            &&v.get("observedReleases").integer()==static_cast<int64_t>(frames.size()-1)&&v.boolean("buttonObligation")&&requiresButtonRecovery(result)
            &&v.get("deviceHeldAfter").integer()==2,"unexpected non-left device edges must be telemetry plus an honest obligation, never an auto release");
        if(name=="move-feedback-throws"||name=="move-feedback-unhealthy")require(frames.size()==1&&releaseWrites==0
            &&!v.boolean("feedbackReliable")&&!v.boolean("pressObserved")&&requiresButtonRecovery(result),
            "unavailable post-write button feedback lost recovery obligation or triggered unsolicited release");
        if(name=="feedback-missing")require(!requiresButtonRecovery(result),"preflight feedback failure invented an input obligation");
        if(name=="motion-tail")require(clock>=70&&outcome!="completed","moving intermediate target reported complete");
        if(name=="pulse-down-up"||name=="pulse-down-up-down"||name=="early-up-drag"){
            require(result.text("errorCode")=="button_released_early"&&v.text("buttonIntegrity")=="failed","cumulative early-up evidence lost between polls");
            require(pressWrites==1&&releaseWrites==1,"early release triggered automatic re-press/release replay");
            require(heldMoves==(name=="early-up-drag"?1:0),"continued dragging after lost button");
            const int pairs=name=="pulse-down-up-down"?2:1;
            require(v.get("observedPresses").integer()==pairs&&v.get("observedReleases").integer()==pairs,"fast button edges collapsed");
        }
        if(name=="focus-while-waiting")require(pressWrites==1&&releaseWrites==1&&result.text("actionErrorCode")=="button_down_timeout","waiting for feedback must not invent window failures");
        if(name=="final-late-down"||name=="final-feedback-loss"||name=="final-device-change")require(pressWrites==1&&releaseWrites==1&&result.text("cleanup")=="release_unconfirmed"&&!v.boolean("releaseStateConfirmed"),"late loss of release proof escaped success or retried input");
        if(name=="final-position-drift")require(pressWrites==1&&releaseWrites==1&&result.text("errorCode")=="final_position_changed"&&result.text("cleanup")=="release_confirmed","released state hid a cursor endpoint failure");
        if(name=="feedback-unhealthy"||name=="feedback-anomaly")require(pressWrites==1&&releaseWrites==1&&result.text("cleanup")=="release_unconfirmed","untrustworthy feedback allowed further business input");
        if(name=="press-no-feedback")require(pressWrites==1&&releaseWrites==1&&result.text("actionErrorCode")=="button_down_timeout","unobserved down permitted click completion");
        if(name=="stale-down")require(pressWrites==1&&releaseWrites==1&&result.text("errorCode")=="stale_button_feedback","old down report admitted new press");
        if(name=="write-throws"||name=="write-fails")require(pressWrites==1&&releaseWrites==1&&outcome=="indeterminate","unknown write skipped bounded cleanup or protection");
        auto t=result.get("transport");require(t.get("attempted").integer()==t.get("written").integer()+t.get("writeFailed").integer(),"receipt counts");
        require(t.get("attempted").integer()==static_cast<int64_t>(frames.size()),"frame/receipt mismatch");
        std::cout<<Json(Json::Object{{"case",name},{"receipt",result},{"frames",Json::Array(frames)},{"fakeOnly",true}}).dump()<<'\n';return 0;
    } catch(const std::exception& e){std::cerr<<e.what();return 1;}
}
