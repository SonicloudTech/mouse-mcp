# Official MCP Registry publication / 官方 MCP Registry 发布

Registry name: `io.github.SonicloudTech/mouse-mcp`. Metadata lives in [`server.json`](../server.json). MCPB 0.1.1 is a packaging release of the existing legacy 0.1.0 runtime; it is not a shared-v2 release.

Registry 名称为 `io.github.SonicloudTech/mouse-mcp`，元数据位于 [`server.json`](../server.json)。MCPB 0.1.1 是现有 legacy 0.1.0 运行文件的封装版本，不是共享 v2 发布版。

## Build and verify / 构建与核验

Download the original v0.1.0 ZIP from GitHub Releases. The builder requires its pinned SHA-256 (`6aac1c0b5c48d888cbc286ce059293a08f6eb878f21bd3262ade2a243c3615b8`), excludes the trial credential file without opening it, and preserves the runtime and third-party notices. Choose a new output directory outside the checkout.

从 GitHub Releases 下载原 v0.1.0 ZIP。构建脚本校验上述固定 SHA-256，不读取试用凭据文件的内容，保留运行文件与第三方许可。输出目录须位于仓库外且尚不存在。

```powershell
python mcp/scripts/build-mcpb.py --source-zip C:/downloads/umouse-mcp-os-win-x64-0.1.0.zip --output-dir C:/builds/umouse-mcpb-0.1.1
npx --yes --package=@anthropic-ai/mcpb@2.1.2 mcpb validate mcpb/manifest.json
```

Use the resulting MCPB hash in `server.json` and `SHA256SUMS.txt`. Upload the MCPB, checksums and sanitized build provenance to the matching GitHub Release. The provenance can include file hashes but must not include local absolute paths or credentials. A new immutable version requires a new release tag and metadata version; never replace a published asset with different bytes.

将生成的 MCPB 哈希写入 `server.json` 和 `SHA256SUMS.txt`，在对应 GitHub Release 上传 MCPB、校验文件与已移除本地路径的构建来源记录。来源记录可包含文件哈希，不应包含本地绝对路径或凭据。新版本须使用新的标签与元数据版本，不能用不同内容替换已发布制品。

## Publish / 发布

Run **Publish to official MCP Registry** from the repository's Actions tab on `main`. The manual workflow downloads the public release, checks SHA-256 and the manifest, and runs a real stdio/native-DLL smoke test on an isolated Windows x64 runner. It calls only initialization, tool discovery and read-only status/device/capability tools, then checks EOF shutdown. No hardware is connected in this test, so it does not establish physical mouse or microphone behavior.

在仓库 Actions 中选择 `main`，手动运行 **Publish to official MCP Registry**。流程下载公开制品、核验 SHA-256 与 manifest，在独立 Windows x64 runner 上检查真实 stdio 与 DLL 加载，只调用初始化、工具发现、状态/设备/能力读取，并检查 stdin 关闭后的退出。此测试没有连接硬件，不能作为鼠标或麦克风实际效果的验收。

Only after that job passes, the publish job authenticates with GitHub Actions OIDC and publishes using a pinned official `mcp-publisher`. No PAT, website change or DNS record is required. An existing exact version must match the checked-in metadata; identical retries skip publication. Different metadata for an existing version fails. The final step reads back the official active record.

Windows 检查通过后，发布任务才使用 GitHub Actions OIDC 认证与固定版本的官方 `mcp-publisher` 发布，无需 PAT、官网修改或 DNS 记录。若同一版本已存在，必须与仓库元数据一致；相同内容重跑跳过发布，不同内容则失败。最后回读官方 active 记录。

If publication times out, check the exact Registry version before retrying. A client timeout does not prove the publication failed.

若发布超时，先检查 Registry 中的精确版本再重试；客户端超时不代表发布失败。

References / 参考：[MCPB package requirements](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/package-types.mdx) · [GitHub Actions OIDC](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/github-actions.mdx) · [MCPB manifest](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md).
