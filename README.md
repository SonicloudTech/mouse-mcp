# umouse-mcp

**English** | [简体中文](README.zh-CN.md)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%20x64-6f42c1.svg)](#)
[![asr](https://img.shields.io/badge/ASR-pluggable-6f42c1.svg)](#voice-dictation-pluggable-asr-providers)
[![language](https://img.shields.io/badge/lang-C%2B%2B%20%7C%20TypeScript-007ec6.svg)](#)

Give large models a **real mouse**. umouse-mcp is a Model Context Protocol (MCP) server: every move, click, scroll and drag leaves the machine as HID frames through a uMouse USB device and is processed by the OS exactly like a physical mouse — **zero software injection**.

> Model → MCP host → shared daemon (`:47192`) → C++ native host → USB HID `0xF0/0xF1` → uMouse device → Windows input pipeline

## Demo

Hardware mouse driving a real browser lab page (gold arrow = system cursor overlaid on the recording) — counters, wheel and hit feedback all come from real browser events:

![uMouse hardware mouse demo](mcp/acceptance/demo/mouse-capabilities.gif)

### Voice typing: speak, and it lands in any window

Hold the device voice key, speak, release — the recognized text is typed into whatever window currently has focus. Both clips recorded live at 1080p:

**Agent client (terminal)** — spoken command typed in and executed:

<video src="mcp/acceptance/demo/voice-typing-agent.mp4" controls muted width="720">mcp/acceptance/demo/voice-typing-agent.mp4</video>

**WeChat** — spoken message typed into the input box and sent:

<video src="mcp/acceptance/demo/voice-typing-wechat.mp4" controls muted width="720">mcp/acceptance/demo/voice-typing-wechat.mp4</video>

## Key capabilities

- **Hardware actions**: `umouse_mouse_action` — move / click / scroll / drag in desktop physical-pixel coordinates, multi-monitor with negative coords, optional `precision: standard | high`.
- **Task exclusivity**: `umouse_control` begin → actions → end; only one task drives the mouse and keyboard at a time; dead connections are cleaned up automatically.
- **Read-only sensors**: `umouse_input_status` — cursor position, live key state, foreground window identity; read-only, never intercepts.
- **Voice dictation**: mic capture → VAD segmentation → pluggable ASR provider → preview / final transcript; an independent lane that never preempts mouse control (see below).
- **Shared daemon**: one instance per machine (port 47192), shared across ZCode / Codex / Claude hosts, reclaimed when idle.

## Voice dictation: pluggable ASR providers

ASR here is not a black box tied to one vendor — it is a tiny interface contract: implement `begin / writePcm / finishInput / cancel` and emit `preview / segmentFinal / warning / terminal` (exactly once), and you have a valid provider. Swapping recognition services means swapping one factory function; `mcp/src/sinicloud-asr.ts` is a complete reference implementation.

| Provider (`UMSDK_ASR_PROVIDER`) | Notes |
|---|---|
| `sinicloud` (default on Windows) | Sonicloud open-platform streaming ASR: pure TypeScript, no DLL dependency; streams 16k/16bit/mono PCM, interim previews, low-balance warnings without dropping the stream |
| `windows-speech` | Built-in Windows recognizer; offline, audio never leaves the machine |
| `whisper-cpp` | Self-hosted whisper-cli + ggml model (paths configurable), offline CPU transcription |
| `http` | Custom transcription endpoint: multipart WAV in, `{"text"}` out |
| `disabled` | Dictation off; a missing provider degrades gracefully to `asr_unavailable` |

Credentials travel only through configuration and are **hot-read per session — swap keys without a restart**: by default a JSON file at `<data-dir>/sinicloud_asr.json` (`appId / apiKey / apiSecret / userId / lanid / streamUrl / tokenUrl`); environment variables `UMSDK_ASR_APP_ID / UMSDK_ASR_API_KEY / UMSDK_ASR_API_SECRET / …` override the file. Never hardcoded, never printed, never logged, never committed. The release bundle ships a **trial credential** for the open platform so dictation works out of the box; replace it with your own key for production use. See `mcp/SHARED-V2.md` for the full provider matrix.

## Cross-machine adaptive positioning

Windows pointer ballistics ("Enhance pointer precision") make the protocol-dots → pixels gain vary with amplitude. umouse-mcp ships an 11-step ballistic gain curve: read-only seeded from local pointer settings on first use of a device, learned online frame-by-frame within `[0.125, 10]`, decaying back to the seed after 60 s idle — **no tuning when you change machines or devices**; a stale seed costs 1–2 extra frames. Design and measurements: `mcp/sdk-host/POSITIONING.md`.

| Metric | standard | high |
|---|---|---|
| Stop tolerance | residual ≤ 4 px | residual ≤ 1 px |
| Measured (reference rig) | median 356 ms / 2 frames | max 1 px, mean 0.67 px |
| Failure mode | identical; high at worst degrades to ≤ 4 px best-effort, residuals reported as-is | |

## One-command acceptance

32 cases verify effects in closed loop on a real browser page: left / right / middle click counts, double-click interval, wheel `scrollTop`, drag linearity, 1 px bullseye hits.

```bash
cd mcp/acceptance
UMCFG=<client.json> UMBUNDLE=<bundle> node run-matrix.mjs
# writes acceptance-report.json · exit code 0 = all green (reference run 32/32)
```

## Quick start

1. Bring your own uMouse USB device (VID:PID `0ABC9:0CA89`); Windows x64 + Node.js 22.
2. Download the self-contained bundle `umouse-mcp-os-win-x64-*.zip` from [Releases](../../releases), unzip anywhere.
3. Double-click `install-agents.cmd` (ZCode by default; `claude` / `cursor` / `all` supported), or add manually:

```json
{
  "mcpServers": {
    "umouse": { "command": "node", "args": ["C:\\path\\to\\umouse-mcp-os-win-x64\\mcp\\dist\\index.js"] }
  }
}
```

4. Ask your agent to call `umouse_status` — `sdkVersion` in the reply means you are connected.

Build from source: `npm ci && npm run build && npm test` (Windows x64; native SDK ships as DLLs + public header, see `include/umouse_sdk.h`).

## Security model

- Locked screen / UAC / secure desktop: key actions are rejected with `button_feedback_input_desktop_unavailable` — that is a safety property, not a bug.
- `effectConfirmed` is always `false`: transport success ≠ application effect; the acceptance lab's page evidence is the ground truth.
- ASR credentials enter only via local config file and environment variables — never committed, printed or logged; `recover` requires a human carrying `--hardware-reset-confirmed`.

## Documentation

| Doc | Contents |
|---|---|
| `mcp/SHARED-V2.md` | Shared-v2 install, upgrade, maintenance and recovery |
| `mcp/acceptance/MOUSE-CAPABILITY-TESTS.md` | The 32-case catalog (copy-paste MCP calls and pass criteria) |
| `mcp/sdk-host/POSITIONING.md` | Ballistic positioning: history, algorithm, cross-device matrix |
| `mcp/README.md` | Full MCP tool reference (Chinese) |

## Commercial & Support

Maintained by [SonicloudTech](https://github.com/SonicloudTech) (Anhui SoniCloud Intelligent Technology Co., Ltd.) — AI input hardware and the speech open platform.

- Website: <https://sinicloud.com/>
- Speech open platform: <https://open.sinicloud.com/> — powers the default ASR provider; sign up for a trial quota
- Business & technical contact: [xu_heng_yu@sinicloud.com](mailto:xu_heng_yu@sinicloud.com) — OEM / distribution / custom firmware / co-development; include the target platform, expected volume, device model, firmware version and intended use case

<img src="img/微信.png" alt="SoniCloud contact QR code" width="200" style="max-width: 100%; height: auto;">

## Roadmap

- [x] Cross-machine adaptive gain curves (v0.4)
- [x] Pluggable ASR providers: sinicloud streaming, fully configurable credentials
- [ ] Firmware-executed 1–2 count micro-correction frames
- [ ] Wheel ACK and scroll-amount closed loop
- [ ] Absolute positioning mode

## License

Code is released under the [MIT license](LICENSE). The native SDK ships as closed-source DLLs with a public header (`include/umouse_sdk.h`).
