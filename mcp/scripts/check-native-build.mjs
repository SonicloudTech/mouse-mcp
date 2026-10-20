import fs from 'node:fs';
for (const name of ['umouse-sdk-host.exe', 'umcp_fake.dll', 'umcp_bad_abi.dll',
  'umcp-adapter-contract.exe', 'umcp-hardware-contract.exe', 'umcp-raw-feedback-contract.exe', 'umcp-sequence-contract.exe', 'umcp-input-quarantine-contract.exe', 'umcp-diagnostics-contract.exe', 'umcp-job-parent.exe', 'umcp_test_vendor.dll', 'umcp_test_vendor_legacy_screen.dll']) {
  if (!fs.existsSync(`mcp/sdk-host/build/bin/${name}`)) throw new Error('Run npm run build:sdk-host:test before test:shared; native tests must not silently skip.');
}
