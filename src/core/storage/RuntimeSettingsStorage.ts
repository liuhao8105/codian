/**
 * RuntimeSettingsStorage - Handles Codian runtime settings.
 *
 * Manages the .codian/settings.json file.
 *
 * Only runtime permission fields are stored here:
 * - permissions (allow/deny/ask)
 */

import type {
  PermissionRule,
  RuntimePermissions,
  RuntimeSettings,
} from '../types';
import {
  DEFAULT_RUNTIME_PERMISSIONS,
  DEFAULT_RUNTIME_SETTINGS,
} from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

/** Path to runtime settings file relative to vault root. */
export const RUNTIME_SETTINGS_PATH = '.codian/settings.json';

function normalizeRuleList(value: unknown): PermissionRule[] {
  if (!Array.isArray(value)) return [];
  return value.filter((r): r is string => typeof r === 'string') as PermissionRule[];
}

function normalizePermissions(permissions: unknown): RuntimePermissions {
  if (!permissions || typeof permissions !== 'object') {
    return { ...DEFAULT_RUNTIME_PERMISSIONS };
  }

  const p = permissions as Record<string, unknown>;
  return {
    allow: normalizeRuleList(p.allow),
    deny: normalizeRuleList(p.deny),
    ask: normalizeRuleList(p.ask),
    defaultMode: typeof p.defaultMode === 'string' ? p.defaultMode as RuntimePermissions['defaultMode'] : undefined,
    additionalDirectories: Array.isArray(p.additionalDirectories)
      ? p.additionalDirectories.filter((d): d is string => typeof d === 'string')
      : undefined,
  };
}

/**
 * Storage for runtime permission settings.
 *
 * Note: Permission update methods (addAllowRule, addDenyRule, etc.) use a
 * read-modify-write pattern. Concurrent calls may race and lose updates.
 * In practice this is fine since user interactions are sequential.
 */
export class RuntimeSettingsStorage {
  constructor(private adapter: VaultFileAdapter) { }

  /**
   * Load runtime settings from .codian/settings.json.
   * Returns default settings if file doesn't exist.
   * Throws if file exists but cannot be read or parsed.
   */
  async load(): Promise<RuntimeSettings> {
    if (!(await this.adapter.exists(RUNTIME_SETTINGS_PATH))) {
      return { ...DEFAULT_RUNTIME_SETTINGS };
    }

    const content = await this.adapter.read(RUNTIME_SETTINGS_PATH);
    const stored = JSON.parse(content) as Record<string, unknown>;

    return {
      ...stored,
      permissions: normalizePermissions(stored.permissions),
    };
  }

  /**
   * Save runtime settings to .codian/settings.json.
   * Preserves unknown fields for runtime compatibility.
   *
   */
  async save(settings: RuntimeSettings): Promise<void> {
    const merged: RuntimeSettings = {
      permissions: settings.permissions ?? { ...DEFAULT_RUNTIME_PERMISSIONS },
    };

    const content = JSON.stringify(merged, null, 2);
    await this.adapter.write(RUNTIME_SETTINGS_PATH, content);
  }

  async exists(): Promise<boolean> {
    return this.adapter.exists(RUNTIME_SETTINGS_PATH);
  }

  async getPermissions(): Promise<RuntimePermissions> {
    const settings = await this.load();
    return settings.permissions ?? { ...DEFAULT_RUNTIME_PERMISSIONS };
  }

  async updatePermissions(permissions: RuntimePermissions): Promise<void> {
    const settings = await this.load();
    settings.permissions = permissions;
    await this.save(settings);
  }

  async addAllowRule(rule: PermissionRule): Promise<void> {
    const permissions = await this.getPermissions();
    if (!permissions.allow?.includes(rule)) {
      permissions.allow = [...(permissions.allow ?? []), rule];
      await this.updatePermissions(permissions);
    }
  }

  async addDenyRule(rule: PermissionRule): Promise<void> {
    const permissions = await this.getPermissions();
    if (!permissions.deny?.includes(rule)) {
      permissions.deny = [...(permissions.deny ?? []), rule];
      await this.updatePermissions(permissions);
    }
  }

  async addAskRule(rule: PermissionRule): Promise<void> {
    const permissions = await this.getPermissions();
    if (!permissions.ask?.includes(rule)) {
      permissions.ask = [...(permissions.ask ?? []), rule];
      await this.updatePermissions(permissions);
    }
  }

  /**
   * Remove a rule from all lists.
   */
  async removeRule(rule: PermissionRule): Promise<void> {
    const permissions = await this.getPermissions();
    permissions.allow = permissions.allow?.filter(r => r !== rule);
    permissions.deny = permissions.deny?.filter(r => r !== rule);
    permissions.ask = permissions.ask?.filter(r => r !== rule);
    await this.updatePermissions(permissions);
  }

}
