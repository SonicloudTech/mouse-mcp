# Native SDK host (Windows x64, shared v2; hardware acceptance pending)

The C++ executable exclusively owns SDK loading and native calls. The TypeScript
service owns MCP sessions and voice orchestration. Direct mouse actions and HID
sequences go to the native adapter; cursor feedback, guarded down/up timing and
cancellation cleanup remain inside C++. There is no observation/planning worker.
Optional targets are pinned to the foreground before the first write.

Build with Visual Studio 2022 and CMake:

```powershell
powershell.exe -NoProfile -File mcp/sdk-host/build.ps1 -Test -SdkInclude C:/SDK/include
npm run test:shared
```

`SdkInclude` contains the public `umouse_sdk.h`. No SDK implementation is compiled
or linked. The MCP repository does not include SDK implementation sources.
The independent JSON parser is yyjson (MIT); its source and license are under
`third_party/yyjson`, copied unchanged from the existing vendored dependency.

`umcp_plugin.h` defines the versioned C ABI. Plugins receive borrowed JSON/binary
buffers, copy events before returning, serialize calls, and must join callbacks
and threads before reporting a successful stop. Current adapters are `umouse`,
`asr`, `typer`, `screen`. They load external vendor DLLs by absolute path and
manifest SHA-256. No hot reload: stop, observe process exit, replace, regenerate
manifest, restart. Optional missing libraries disable only their component.
ScreenTool requires `sct_destroy_wait`; an older DLL is explicitly unavailable.

The native protocol is private stdin/stdout JSONL, not MCP. SDK stdout is moved
to stderr. Startup requires pipes, a parent process, matching profile and epoch,
and per-user ownership locks. Test manifests accept only the fake plugin, use a
separate lock namespace and cannot initialize real SDK adapters. The host owns
a Windows kill-on-close Job and independently observes parent death.

`-Test` also builds an isolated vendor ABI fixture and adapter contract runner.
Those tests load the real adapter code against fixture DLLs only; they exercise
callbacks, ASR shutdown barriers, cancellation and unresolved microphone drains.
They never load the real SDK, connect hardware, upload audio or inject OS input.
They do not establish real-device correctness or full vendor ABI compatibility.

Production startup requires `runtimeStateDir`. A flushed `sdk-running.json`
marker remains after a crash or unconfirmed hardware cleanup and blocks another
SDK initialization. It is never removed merely because a process died. Recovery
requires separately establishing hardware quiescence; no automatic input replay
or blind marker deletion is allowed. The local management command archives the
markers only after explicit hardware-reset confirmation and matching evidence
hashes while holding SDK ownership locks. It does not verify physical quiescence.

Metadata-only helpers `--identity` and `--tcp-owner <server-port> <client-port>`
query Windows user/session/process identity without loading SDK plugins.

The old `mcp/dist/index.js` entry is retained. Shared entry points are
`mcp/dist/shared/daemon-main.js` and `mcp/dist/shared/connector.js`. See the local
audit records for implementation limits and hardware acceptance status. Do not
replace an existing MCP entry merely on the basis of fake-process test success.
The private connector pipe uses protocol v2 mutual HMAC challenge authentication;
it does not transmit a bearer token or the full derived secret to that endpoint.

`--service-run` runs a Node listener under a root kill-on-close Job. Normal startup
uses `start-shared.ps1` and local WMI so an Agent's inherited Job cannot kill the
shared listener. The native host and voice UI belong to the root Job.
No login task is installed. `manage start` starts the listener only; MCP initialize
drives SDK lifetime. See [shared v2 management](../SHARED-V2.md).
