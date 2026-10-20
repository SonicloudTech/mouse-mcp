import fs from 'node:fs';
import path from 'node:path';
import { createInstallation, pairClient, revokeClient, verifyBundle, upgradeInstallation, rollbackInstallation, recoverInstallation, stopForMaintenance, startService, adminCall, withInstallLock, validateId, validateCapabilities, setCapabilities, writeJson } from './installation.js';
import { identity } from './daemon-main.js';
const [command, requestedDirectory, value, ...flags] = process.argv.slice(2);
let directory = requestedDirectory;
async function main() {
  if (!directory || !path.isAbsolute(directory)) throw new Error('Usage: manage init|pair|rotate|revoke|upgrade|rollback|recover|status|stop|config <absolute-install-dir> [client-id|bundle] [--disconnect] [--hardware-reset-confirmed]');
  if (fs.existsSync(directory)) directory = fs.realpathSync.native(directory);
  const allFlags = [value, ...flags];
  if (!['init','pair','rotate','revoke','reload-clients','upgrade','rollback','recover','status','start','stop','config','resume','bind-session','capabilities','uninstall'].includes(command)) throw new Error('unknown_command');
  if (['pair','rotate','revoke','config'].includes(command)) validateId(value);
  if (command === 'recover' && !allFlags.includes('--hardware-reset-confirmed')) throw new Error('explicit_hardware_reset_confirmation_required');
  const bundle = ['init','upgrade'].includes(command) ? verifyBundle(value) : undefined;
  const profile = command === 'capabilities' ? JSON.parse(fs.readFileSync(value, 'utf8')) : undefined;
  if (command === 'capabilities') validateCapabilities(profile);
  // The listener takes the same maintenance lock while starting. Never wait for it while holding that lock.
  if(command==='start') { console.log(JSON.stringify(await startService(directory))); return; }
  const result = await withInstallLock(directory, async () => {
    if (command === 'init') return createInstallation(directory, bundle!, flags[0] ?? 'agent');
    if (command === 'status') return await adminCall(directory, 'status') ?? { serviceRunning: false };
    if (command === 'config') {
      const cfg = JSON.parse(fs.readFileSync(path.join(directory, 'service.json'), 'utf8'));
      if (typeof cfg.bundleRoot !== 'string') throw new Error('legacy_installation_requires_managed_init');
      const client = path.join(directory, 'clients', `${value}.json`); if (!cfg.principals.some((p: any) => p.id === value && !p.permissions.includes('admin')) || !fs.existsSync(client)) throw new Error('client_not_found');
      return { mcpServers: { umouse: { command: process.execPath, args: [path.join(cfg.bundleRoot, 'mcp/dist/shared/connector.js'), client] } }, configApplied: false };
    }
    const maintenanceFile = path.join(directory, 'maintenance.json');
    const maintenance=fs.existsSync(maintenanceFile)?JSON.parse(fs.readFileSync(maintenanceFile,'utf8')):null;
    if(command==='reload-clients') {
      if(maintenance&&!maintenance.needsClientReload)throw new Error('installation_in_maintenance');
      const result=await adminCall(directory,'reload-clients');if(maintenance?.needsClientReload)fs.rmSync(maintenanceFile);
      return result??{clientsReloaded:true,serviceRunning:false};
    }
    if(['pair','rotate','revoke'].includes(command)) {
      if(maintenance)throw new Error('installation_in_maintenance');
      let result:object;
      if(command==='revoke'){revokeClient(directory,value);result={revoked:value};}
      else result={connectorConfig:pairClient(directory,value,undefined,command==='rotate')};
      try { await adminCall(directory,'reload-clients'); }
      catch { writeJson(maintenanceFile,{command,needsClientReload:true,at:new Date().toISOString()});throw new Error('client_reload_unconfirmed_retry_reload_clients'); }
      return result;
    }
    if (command === 'resume') {
      if(maintenance?.needsClientReload)throw new Error('client_reload_required');
      await adminCall(directory, 'resume'); fs.rmSync(maintenanceFile, { force: true }); return { resumed: true, hardwareRecoveryPerformed: false };
    }
    // This durable marker also blocks service auto-launch after a failed transaction.
    writeJson(maintenanceFile, { command, at: new Date().toISOString() });
    await stopForMaintenance(directory, allFlags.includes('--disconnect'));
    let result: object;
    if (command === 'upgrade') { upgradeInstallation(directory, bundle!); result = { upgraded: true }; }
    else if (command === 'rollback') { rollbackInstallation(directory); result = { rolledBack: true }; }
    else if (command === 'recover') result = recoverInstallation(directory, true);
    else if (command === 'capabilities') { setCapabilities(directory, profile); result = { configured: true, detectedByHardware: false }; }
    else if (command === 'uninstall') {
      const file=path.join(directory,'service.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      // Disable admission while retaining credentials, recordings and ledgers for explicit export/removal.
      writeJson(file,{...cfg,principals:cfg.principals.filter((p:any)=>p.permissions.includes('admin'))});
      writeJson(maintenanceFile,{command:'uninstalled',at:new Date().toISOString()});
      return {uninstalled:true,serviceStopped:true,hostConfigurationsModified:false,retainedDirectory:directory,retainedSafetyDirectory:cfg.environment.UMSDK_SHARED_SAFETY_DIR};
    } else if (command === 'bind-session') {
      const file = path.join(directory, 'service.json'), cfg = JSON.parse(fs.readFileSync(file,'utf8')), who = identity(cfg.executable);
      if (who.sid !== cfg.sid) throw new Error('windows_user_mismatch'); writeJson(file, { ...cfg, windowsSessionId: who.windowsSessionId }); result = { sessionBound: true };
    } else return { stopped: true, maintenanceRetained: true };
    fs.rmSync(maintenanceFile, { force: true }); return result;
  });
  console.log(JSON.stringify({ ...result, sdkStartedByCommand: false }));
}
void main().catch(e => { console.error(e instanceof Error ? e.message : 'management_failed'); process.exitCode = 1; });
