#pragma once
#include "plugin_support.hpp"
namespace umcp {
inline std::wstring quoteArg(const std::wstring& value) {
    std::wstring out=L"\"";size_t slashes=0;
    for(auto c:value){if(c==L'\\'){++slashes;continue;}if(c==L'\"'){out.append(slashes*2+1,L'\\');out+=c;}else{out.append(slashes,L'\\');out+=c;}slashes=0;}
    out.append(slashes*2,L'\\');out+=L'\"';return out;
}
// The wrapper waits for Node for the whole service lifetime and stays alive at N=0
// until Node's idle exit fires. Its Job owns Node + voice UI + SDK descendants.
inline int serviceRun(const std::wstring& node,const std::wstring& script,const std::wstring& config) {
    for(auto& s:{node,script,config})if(!std::filesystem::path(s).is_absolute()||!std::filesystem::is_regular_file(s))throw std::runtime_error("absolute_service_files_required");
    HANDLE job=CreateJobObjectW(nullptr,nullptr);if(!job)throw std::runtime_error("service_job_failed");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))){CloseHandle(job);throw std::runtime_error("service_job_failed");}
    STARTUPINFOW startup{};startup.cb=sizeof(startup);PROCESS_INFORMATION process{};
    auto command=quoteArg(node)+L" "+quoteArg(script)+L" "+quoteArg(config);
    if(!CreateProcessW(node.c_str(),command.data(),nullptr,nullptr,FALSE,CREATE_SUSPENDED|CREATE_NO_WINDOW,nullptr,std::filesystem::path(config).parent_path().c_str(),&startup,&process)){CloseHandle(job);throw std::runtime_error("service_spawn_failed");}
    if(!AssignProcessToJobObject(job,process.hProcess)||ResumeThread(process.hThread)==static_cast<DWORD>(-1)){TerminateProcess(process.hProcess,70);CloseHandle(process.hThread);CloseHandle(process.hProcess);CloseHandle(job);throw std::runtime_error("service_job_assign_failed");}
    CloseHandle(process.hThread);WaitForSingleObject(process.hProcess,INFINITE);DWORD code=70;GetExitCodeProcess(process.hProcess,&code);CloseHandle(process.hProcess);CloseHandle(job);return static_cast<int>(code);
}
inline void sdkLeases(PipeLease& worker,PipeLease& legacy,const Json& manifest) {
    if(manifest.number("schemaVersion",0,1,1)!=1)throw std::runtime_error("manifest_version");
    if(manifest.text("profile")!="test"&&manifest.text("profile")!="production")throw std::runtime_error("invalid_profile");
    bool testing=manifest.text("profile")=="test";
    auto suffix=testing?"test-"+manifest.text("testNamespace"):"sid-"+currentSid();
    if(testing && (suffix.size()<13||suffix.size()>85||suffix.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-")!=std::string::npos))throw std::runtime_error("test_namespace_required");
    worker.acquire(wide("\\\\.\\pipe\\umouse-sdk-host-"+suffix));
    if(!testing){wchar_t home[32768];DWORD n=GetEnvironmentVariableW(L"USERPROFILE",home,32768);if(!n||n>=32768)throw std::runtime_error("user_profile_required");std::wstring lower(home,n);for(auto& c:lower)c=static_cast<wchar_t>(towlower(c));legacy.acquire(wide("\\\\.\\pipe\\umouse-sdk-"+sha256(utf8(lower)).substr(0,24)));}
}
inline Json recoverState(const std::filesystem::path& manifestFile,const std::string& sdkHash,const std::filesystem::path& inputFile,const std::string& inputHash,const std::string& nativeInputHash="",const std::string& inflightHash="") {
    auto manifest=Json::parse(readFile(manifestFile,1024*1024));PipeLease worker,legacy;sdkLeases(worker,legacy,manifest);
    std::filesystem::path state;
    for(auto& p:manifest.get("plugins").items())if(p.text("id")=="umouse"||p.text("id")=="fake")state=wide(p.get("config").text("runtimeStateDir"));
    if(!state.is_absolute()||!inputFile.is_absolute())throw std::runtime_error("absolute_recovery_state_required");
    std::vector<std::pair<std::filesystem::path,std::string>> markers{{state/L"sdk-running.json",sdkHash},{inputFile,inputHash}};
    const auto nativeInput=state/L"native-input-quarantine.json";
    // Older maintenance callers may not accidentally discard new input-only
    // evidence. The operator must review the same hash this process archives.
    if(nativeInputHash.empty()) {
        if(std::filesystem::exists(nativeInput))throw std::runtime_error("native_input_recovery_evidence_required");
    } else markers.emplace_back(nativeInput,nativeInputHash);
    const auto inflight=state/L"input-in-flight.json";
    // Recovery must account for every durable input gate under the same SDK
    // leases. A legacy caller cannot omit an existing in-flight marker.
    if(inflightHash.empty()) {
        if(std::filesystem::exists(inflight))throw std::runtime_error("input_inflight_recovery_evidence_required");
    } else markers.emplace_back(inflight,inflightHash);
    for(auto& [file,hash]:markers){bool exists=std::filesystem::exists(file);if(hash=="none"?!exists:exists&&sha256(readFile(file,65536))==hash)continue;throw std::runtime_error("recovery_evidence_changed");}
    Json::Array archived;
    for(auto& [file,hash]:markers)if(hash!="none"){
        auto backup=file;backup+=L".recovered-"+std::to_wstring(GetCurrentProcessId());
        if(!MoveFileExW(file.c_str(),backup.c_str(),MOVEFILE_WRITE_THROUGH))throw std::runtime_error("recovery_archive_failed");
        archived.push_back(utf8(backup.wstring()));
    }
    return Json::Object{{"archived",archived},{"sdkLoaded",false},{"hardwareResetConfirmedByOperator",true},{"physicalVerifiedBySoftware",false}};
}
}
