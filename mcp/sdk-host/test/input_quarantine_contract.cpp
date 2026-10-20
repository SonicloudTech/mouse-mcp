#include "input_quarantine.hpp"
#include "maintenance.hpp"
#include <iostream>
using namespace umcp;
int wmain(int argc,wchar_t** argv) {
    try {
        if(argc!=2)throw std::runtime_error("state directory required");
        const std::filesystem::path dir(argv[1]);std::filesystem::create_directories(dir);
        int checks=0;auto require=[&](bool value,const char* reason){++checks;if(!value)throw std::runtime_error(reason);};
        auto throws=[&](auto run,const std::string& expected){try{run();throw std::runtime_error("missing expected failure");}catch(const std::exception& e){require(e.what()==expected,"unexpected error");}};
        auto receipt=[](const char* outcome,int attempted,const char* cleanup="not_needed"){
            return Json(Json::Object{{"outcome",outcome},{"cleanup",cleanup},{"transport",Json::Object{{"attempted",attempted}}}});
        };
        InputQuarantine q;q.load(dir);require(!q.any(),"new state blocked");
        q.begin({"mouse"},"fake");require(q.blocked("mouse")&&!q.blocked("keyboard"),"scope separation failed");
        InputQuarantine restarted;restarted.load(dir);require(restarted.blocked("mouse"),"pre-write marker not durable");
        restarted.begin({"mouse"},"fake");
        require(!restarted.status().boolean("enforced"),"diagnostic became a fault latch");
        q.finish({"mouse"},receipt("indeterminate",3,"release_unconfirmed"),true);
        require(q.blocked("mouse"),"unknown result cleared");
        q.begin({"keyboard"},"fake");q.finish({"keyboard"},receipt("completed",2),false);
        require(q.blocked("mouse")&&!q.blocked("keyboard"),"keyboard completion cleared mouse quarantine");
        q.begin({"keyboard"},"fake");q.finish({"keyboard"},receipt("rejected",0),false);
        require(q.blocked("mouse")&&!q.blocked("keyboard"),"zero-write rejection leaked scope");
        q.begin({"keyboard"},"fake");q.finish({"keyboard"},receipt("indeterminate",1,"release_written"),false);
        require(q.blocked("mouse")&&q.blocked("keyboard"),"uncertain write result falsely cleared");
        InputQuarantine again;again.load(dir);require(again.blocked("mouse")&&again.blocked("keyboard"),"restart forgot scope");
        // movement-only records stay classifiable after a terminal failure; a fresh
        // full key scan discharges them via acknowledgeReleased, archiving bytes.
        q.acknowledgeReleased();
        require(!q.any(),"acknowledge did not release scopes");
        q.begin({"mouse"},"fake",true);
        require(q.movementOnly(),"movement-only flag lost in journal");
        require(q.status().get("movementOnly").boolean("mouse"),"status lost movement-only scope");
        q.finish({"mouse"},receipt("indeterminate",2,"release_written"),true);
        require(q.blocked("mouse")&&!q.movementOnly(),"held obligation must disprove movement-only");
        q.begin({"mouse"},"fake",true);q.finish({"mouse"},receipt("indeterminate",2,"release_written"),false);
        require(q.blocked("mouse")&&q.movementOnly(),"terminal failure dropped movement-only flag");
        InputQuarantine persisted;persisted.load(dir);require(persisted.movementOnly(),"movement-only not durable");
        q.acknowledgeReleased();
        require(!q.any()&&!std::filesystem::exists(dir/L"native-input-quarantine.json"),"acknowledge left the journal");
        q.begin({"keyboard"},"fake");
        require(!q.movementOnly(),"record without flag counted as movement-only");
        q.begin({"mouse"},"fake",false);q.finish({"mouse"},receipt("indeterminate",1,"release_written"),true);
        require(q.blocked("mouse")&&q.blocked("keyboard")&&!q.movementOnly(),"button-suspect state expected");
        // Recovery must validate all evidence before moving even the first file.
        auto manifest=dir/L"manifest.json",input=dir/L"input-uncertain.json",native=dir/L"native-input-quarantine.json";
        auto ns="contract-"+std::to_string(GetCurrentProcessId());
        Json plugin=Json::Object{{"id","fake"},{"config",Json::Object{{"runtimeStateDir",utf8(dir.wstring())}}}};
        {std::ofstream out(manifest);out<<Json(Json::Object{{"schemaVersion",1},{"profile","test"},{"testNamespace",ns},{"plugins",Json::Array{plugin}}}).dump();}
        throws([&]{recoverState(manifest,"none",input,"none");},"native_input_recovery_evidence_required");
        throws([&]{recoverState(manifest,"none",input,"none","none");},"recovery_evidence_changed");
        require(std::filesystem::exists(native),"mismatch destroyed evidence");
        auto recovery=recoverState(manifest,"none",input,"none",sha256(readFile(native,65536)));
        require(recovery.get("archived").items().size()==1&&!std::filesystem::exists(native),"native recovery failed");
        require(!recovery.boolean("physicalVerifiedBySoftware"),"operator reset relabelled physical verification");
        q.load(dir);q.begin({"mouse"},"fake");q.finish({"mouse"},receipt("completed",3,"release_confirmed"),false);
        require(!q.any()&&!std::filesystem::exists(native),"confirmed result did not clear own scope");
        {std::ofstream out(native);out<<"{broken";}
        q.load(dir);require(q.blocked("mouse")&&q.blocked("keyboard"),"corrupt marker bypass");
        auto noParent=dir/L"missing-parent";InputQuarantine failed;failed.load(noParent);
        throws([&]{failed.begin({"mouse"},"fake");},"input_journal_write_failed");
        require(failed.blocked("mouse")&&!failed.persistenceHealthy(),"failed persistence released input gate");
        std::cout<<Json(Json::Object{{"fakeOnly",true},{"sdkLoaded",false},{"inputInjection",false},{"checks",checks}}).dump()<<'\n';return 0;
    }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
