#pragma once
#include "platform.hpp"
#include "json.hpp"
#include <set>
#include <chrono>
namespace umcp {
// Historical name/path retained for migration. This is diagnostic evidence, not
// an admission latch. Task ownership is enforced by the shared daemon.
class InputQuarantine {
    std::filesystem::path file_;
    Json::Object scopes_;
    bool persistenceHealthy_=true;
    void archive(const wchar_t* suffix) {
        if(file_.empty()||!std::filesystem::exists(file_))return;
        auto target=file_;target+=suffix+std::to_wstring(GetCurrentProcessId())+L"-"+
            std::to_wstring(std::chrono::steady_clock::now().time_since_epoch().count());
        if(!CopyFileW(file_.c_str(),target.c_str(),TRUE))throw std::runtime_error("input_journal_archive_failed");
    }
    void persist(const Json::Object& scopes) {
        if(file_.empty())throw std::runtime_error("input_journal_unconfigured");
        if(scopes.empty()) {
            if(!DeleteFileW(file_.c_str())&&GetLastError()!=ERROR_FILE_NOT_FOUND)
                throw std::runtime_error("input_journal_cleanup_failed");
            return;
        }
        auto temporary=file_;temporary+=L".tmp-"+std::to_wstring(GetCurrentProcessId());
        auto data=Json(Json::Object{{"schemaVersion",1},{"scopes",scopes}}).dump();DWORD written=0;
        HANDLE h=CreateFileW(temporary.c_str(),GENERIC_WRITE,0,nullptr,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);
        if(h==INVALID_HANDLE_VALUE)throw std::runtime_error("input_journal_write_failed");
        bool ok=WriteFile(h,data.data(),static_cast<DWORD>(data.size()),&written,nullptr)&&written==data.size()&&FlushFileBuffers(h);
        CloseHandle(h);
        if(!ok||!MoveFileExW(temporary.c_str(),file_.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)) {
            DeleteFileW(temporary.c_str());throw std::runtime_error("input_journal_write_failed");
        }
    }
public:
    void load(const std::filesystem::path& directory) {
        file_=directory/L"native-input-quarantine.json";scopes_.clear();persistenceHealthy_=true;
        try {
            if(!std::filesystem::exists(file_))return;
            auto j=Json::parse(readFile(file_,65536));
            if(j.number("schemaVersion",0,1,1)!=1||!j.get("scopes").object())throw std::runtime_error("invalid_input_journal");
            for(auto& [scope,value]:std::get<Json::Object>(j.get("scopes").v)) {
                if((scope!="mouse"&&scope!="keyboard")||!value.object()||value.text("reason").empty())throw std::runtime_error("invalid_input_journal");
                scopes_[scope]=value;
            }
            if(scopes_.empty())throw std::runtime_error("invalid_input_journal");
        } catch(...) {
            // Preserve unknown scope. Admission still uses fresh per-action
            // guards; a damaged historical record is not a permanent lock.
            scopes_={{"mouse",Json::Object{{"reason","invalid_input_journal"}}},{"keyboard",Json::Object{{"reason","invalid_input_journal"}}}};
        }
    }
    bool blocked(const std::string& scope) const {return scopes_.count(scope)!=0;}
    bool any() const {return !scopes_.empty();}
    bool persistenceHealthy() const {return persistenceHealthy_;}
    bool movementOnly() const {
        if(scopes_.empty())return false;
        for(auto& [scope,value]:scopes_)if(!value.boolean("movementOnly"))return false;
        return true;
    }
    Json status() const {
        Json::Object movement{{"mouse",scopes_.count("mouse")&&scopes_.at("mouse").boolean("movementOnly")},
            {"keyboard",scopes_.count("keyboard")&&scopes_.at("keyboard").boolean("movementOnly")}};
        return Json::Object{{"mouse",blocked("mouse")},{"keyboard",blocked("keyboard")},{"enforced",false},
            {"movementOnly",std::move(movement)},{"persistenceHealthy",persistenceHealthy_}};
    }
    void begin(const std::set<std::string>& scopes,const std::string& deviceId,bool movementOnlyFlag=false) {
        // Keep the original bytes (including legacy/corrupt markers) before
        // admitting a new explicit command. Never replay a failed command.
        archive(L".history-");
        for(auto& scope:scopes)scopes_[scope]=Json::Object{{"reason","attempting"},{"deviceId",deviceId},{"movementOnly",movementOnlyFlag}};
        try {persist(scopes_);persistenceHealthy_=true;}catch(...){persistenceHealthy_=false;throw;}
    }
    // Called only after a terminal receipt. Exceptions and unknown results keep
    // the pre-write journal; a successful SDK write alone cannot clear it.
    void finish(const std::set<std::string>& scopes,const Json& result,bool held) {
        auto attempted=result.get("transport").get("attempted").integer();
        bool safe=!held&&result.text("cleanup")!="release_unconfirmed"
            &&(result.text("outcome")=="completed"||attempted==0);
        if(!safe) {
            for(auto& scope:scopes) {
                auto device=scopes_[scope].text("deviceId");
                // An observed held obligation disproves a movement-only batch:
                // device-attributed button state changed and was not verified back.
                const bool movementOnlyFlag=scopes_[scope].boolean("movementOnly")&&!held;
                scopes_[scope]=Json::Object{{"reason","terminal_failure"},{"deviceId",device},{"outcome",result.text("outcome")},
                    {"cleanup",result.text("cleanup")},{"held",held},{"movementOnly",movementOnlyFlag}};
            }
            try {persist(scopes_);}catch(...){persistenceHealthy_=false;throw;}
            return;
        }
        auto next=scopes_;for(auto& scope:scopes)next.erase(scope);
        try {persist(next);scopes_=std::move(next);}catch(...){persistenceHealthy_=false;throw;}
    }
    // Recovery-only: a fresh full key scan that observes every button released
    // discharges the stale journal. Evidence is archived, never silently lost.
    void acknowledgeReleased() {
        if(scopes_.empty())return;
        archive(L".released-");
        scopes_.clear();
        try {persist(scopes_);persistenceHealthy_=true;}catch(...){persistenceHealthy_=false;throw;}
    }
};
}
