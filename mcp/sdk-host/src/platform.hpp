#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <bcrypt.h>
#include <filesystem>
#include <string>
#include <stdexcept>
#include <vector>
#include <fstream>
#include <sstream>
#include <iomanip>
#include <cwctype>

namespace umcp {
inline std::wstring wide(const std::string& x) {
    if(x.empty()) return {};
    int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,x.data(),static_cast<int>(x.size()),nullptr,0);
    if(!n) throw std::runtime_error("invalid_utf8");
    std::wstring s(n,0); MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,x.data(),static_cast<int>(x.size()),s.data(),n); return s;
}
inline std::string utf8(const std::wstring& x) {
    if(x.empty()) return {};
    int n=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,x.data(),static_cast<int>(x.size()),nullptr,0,nullptr,nullptr);
    if(!n) throw std::runtime_error("invalid_utf16");
    std::string s(n,0); WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,x.data(),static_cast<int>(x.size()),s.data(),n,nullptr,nullptr); return s;
}
inline std::string sha256(const std::string& bytes) {
    BCRYPT_ALG_HANDLE alg=nullptr; BCRYPT_HASH_HANDLE hash=nullptr; unsigned char out[32];
    if(BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0) throw std::runtime_error("sha256_unavailable");
    auto rc=BCryptCreateHash(alg,&hash,nullptr,0,nullptr,0,0);
    if(rc>=0) rc=BCryptHashData(hash,reinterpret_cast<PUCHAR>(const_cast<char*>(bytes.data())),static_cast<ULONG>(bytes.size()),0);
    if(rc>=0) rc=BCryptFinishHash(hash,out,sizeof(out),0);
    if(hash) BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(alg,0);
    if(rc<0) throw std::runtime_error("sha256_failed");
    std::ostringstream s; for(auto b:out) s<<std::hex<<std::setw(2)<<std::setfill('0')<<int(b); return s.str();
}
inline std::string readFile(const std::filesystem::path& p,size_t limit) {
    std::ifstream f(p,std::ios::binary); if(!f) throw std::runtime_error("file_unavailable");
    std::string s; char buf[65536]; while(f) { f.read(buf,sizeof(buf)); s.append(buf,static_cast<size_t>(f.gcount())); if(s.size()>limit) throw std::runtime_error("file_size_limit"); } return s;
}
inline std::string processSid(HANDLE process) {
    HANDLE token=nullptr; if(!OpenProcessToken(process,TOKEN_QUERY,&token)) throw std::runtime_error("token_failed");
    DWORD n=0; GetTokenInformation(token,TokenUser,nullptr,0,&n); std::vector<unsigned char> bytes(n);
    if(!GetTokenInformation(token,TokenUser,bytes.data(),n,&n)) { CloseHandle(token); throw std::runtime_error("sid_failed"); }
    CloseHandle(token); LPWSTR sid=nullptr;
    if(!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid,&sid)) throw std::runtime_error("sid_failed");
    std::string result=utf8(sid); LocalFree(sid); return result;
}
inline std::string currentSid() { return processSid(GetCurrentProcess()); }
inline DWORD currentSession() { DWORD s=0; if(!ProcessIdToSessionId(GetCurrentProcessId(),&s)) throw std::runtime_error("session_failed"); return s; }
class Library {
    HMODULE module=nullptr;
    HANDLE file=INVALID_HANDLE_VALUE;
public:
    Library()=default; Library(const Library&)=delete; Library& operator=(const Library&)=delete;
    ~Library(){ if(module) FreeLibrary(module); if(file!=INVALID_HANDLE_VALUE) CloseHandle(file); }
    void open(const std::string& path,const std::string& expectedHash="") {
        if(module) throw std::runtime_error("already_loaded");
        auto p=std::filesystem::path(wide(path));
        if(!p.is_absolute() || p.native().rfind(L"\\\\",0)==0) throw std::runtime_error("absolute_local_library_required");
        file=CreateFileW(p.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
        if(file==INVALID_HANDLE_VALUE) throw std::runtime_error("library_file_unavailable");
        if(!expectedHash.empty() && sha256(readFile(p,128*1024*1024))!=expectedHash) throw std::runtime_error("library_hash_mismatch");
        module=LoadLibraryExW(p.c_str(),nullptr,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_SYSTEM32);
        if(!module) throw std::runtime_error("library_load_failed:"+std::to_string(GetLastError()));
    }
    template<class T> T symbol(const char* name) {
        auto p=GetProcAddress(module,name); if(!p) throw std::runtime_error(std::string("missing_export:")+name); return reinterpret_cast<T>(p);
    }
    template<class T> T optionalSymbol(const char* name) { return reinterpret_cast<T>(GetProcAddress(module,name)); }
    void retain() { module=nullptr; file=INVALID_HANDLE_VALUE; } // OS reclaims retained handles at process exit.
};
class PipeLease {
    HANDLE h=INVALID_HANDLE_VALUE;
public:
    PipeLease()=default; PipeLease(const PipeLease&)=delete;
    ~PipeLease(){ if(h!=INVALID_HANDLE_VALUE) CloseHandle(h); }
    void acquire(const std::wstring& name) {
        if(h!=INVALID_HANDLE_VALUE) throw std::runtime_error("lease_already_owned");
        auto acl=wide("D:P(A;;GA;;;"+currentSid()+")"); PSECURITY_DESCRIPTOR sd=nullptr;
        if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(acl.c_str(),SDDL_REVISION_1,&sd,nullptr)) throw std::runtime_error("acl_failed");
        SECURITY_ATTRIBUTES sa{sizeof(sa),sd,FALSE};
        h=CreateNamedPipeW(name.c_str(),PIPE_ACCESS_DUPLEX|FILE_FLAG_FIRST_PIPE_INSTANCE,
                          PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,4096,4096,0,&sa);
        DWORD error=GetLastError(); LocalFree(sd);
        if(h==INVALID_HANDLE_VALUE) throw std::runtime_error("owner_busy:"+std::to_string(error));
    }
};
}
