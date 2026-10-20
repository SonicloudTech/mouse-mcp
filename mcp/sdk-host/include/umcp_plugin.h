#ifndef UMCP_PLUGIN_H
#define UMCP_PLUGIN_H
#include <stdint.h>
#include <stddef.h>

/* Stable C ABI. No STL, exceptions, allocator ownership, or SDK headers cross it.
 * Buffers are UTF-8 JSON unless marked binary and are borrowed for the call only.
 * The host copies events immediately. Plugins must quiesce ALL callbacks/threads
 * in stop() before destroy/unload. Failed stop => host must NOT unload the DLL.
 * Replacement is restart-only; this ABI intentionally has no hot-reload method. */
#ifdef _WIN32
# define UMCP_EXPORT __declspec(dllexport)
# define UMCP_CALL __cdecl
#else
# define UMCP_EXPORT __attribute__((visibility("default")))
# define UMCP_CALL
#endif
#ifdef __cplusplus
extern "C" {
#endif
#define UMCP_PLUGIN_ABI 1u
typedef void (UMCP_CALL *umcp_reply_fn)(void* user, const char* json, size_t length);
typedef int (UMCP_CALL *umcp_event_fn)(void* user, const char* json, size_t length,
                                    const uint8_t* binary, size_t binary_length);
typedef struct umcp_host_v1 {
    uint32_t size;
    uint32_t abi;
    void* user;
    umcp_event_fn emit;
    int (UMCP_CALL *is_cancelled)(void* user);
} umcp_host_v1;
typedef struct umcp_plugin_v1 {
    uint32_t size;
    uint32_t abi;
    const char* id;
    const char* version;
    const char* capabilities_json;
    /* create may load a vendor DLL but must not start acquisition or input. */
    void* (UMCP_CALL *create)(const umcp_host_v1*, const char* config, size_t length,
                             umcp_reply_fn error, void* error_user);
    /* Serialized by host. Exactly one synchronous reply; callbacks use emit. */
    void (UMCP_CALL *call)(void*, const char* method, const char* args, size_t length,
                          umcp_reply_fn reply, void* reply_user);
    int (UMCP_CALL *stop)(void*);
    void (UMCP_CALL *destroy)(void*);
} umcp_plugin_v1;
typedef const umcp_plugin_v1* (UMCP_CALL *umcp_get_plugin_fn)(uint32_t requested_abi);
#ifdef __cplusplus
}
#endif
#endif
