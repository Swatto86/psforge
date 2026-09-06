import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function prepareConfig(state) {
  // dirs::config_dir uses the Windows known-folder API, not the APPDATA override.
  const config = process.platform === 'win32'
    ? execFileSync('pwsh', ['-NoProfile', '-Command', '[Environment]::GetFolderPath("ApplicationData")'],
      { encoding: 'utf8', timeout: 15000 }).trim()
    : join(state, 'config');
  if (!config) throw new Error('Could not resolve the application settings directory');
  const appConfig = join(config, 'PSForge');
  const backup = `${appConfig}.e2e-backup-${randomUUID()}`;
  const hadSettings = existsSync(appConfig);
  if (hadSettings) renameSync(appConfig, backup);
  return {
    config,
    restore() {
      rmSync(appConfig, { recursive: true, force: true });
      if (hadSettings) renameSync(backup, appConfig);
    },
  };
}
