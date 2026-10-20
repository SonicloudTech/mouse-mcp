#include "maintenance.hpp"
#include <iostream>
using namespace umcp;
// Test-only Agent Job. Closing stdin kills its descendants; the WMI-brokered service must survive.
int wmain(int argc,wchar_t** argv) {
    if(argc!=4)return 2;
    HANDLE job=CreateJobObjectW(nullptr,nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if(!job||!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))return 3;
    STARTUPINFOW si{};si.cb=sizeof(si);PROCESS_INFORMATION pi{};
    auto line=quoteArg(argv[1])+L" "+quoteArg(argv[2])+L" "+quoteArg(argv[3]);
    if(!CreateProcessW(argv[1],line.data(),nullptr,nullptr,FALSE,CREATE_SUSPENDED|CREATE_NO_WINDOW,nullptr,nullptr,&si,&pi))return 4;
    if(!AssignProcessToJobObject(job,pi.hProcess))return 5;
    ResumeThread(pi.hThread);CloseHandle(pi.hThread);
    std::cout<<pi.dwProcessId<<std::endl;std::cin.get();CloseHandle(job);
    WaitForSingleObject(pi.hProcess,5000);CloseHandle(pi.hProcess);return 0;
}
