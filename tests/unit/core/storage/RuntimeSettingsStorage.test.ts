
import { RUNTIME_SETTINGS_PATH,RuntimeSettingsStorage } from '../../../../src/core/storage/RuntimeSettingsStorage';
import type { VaultFileAdapter } from '../../../../src/core/storage/VaultFileAdapter';
import { createPermissionRule } from '../../../../src/core/types';

const mockAdapter = {
    exists: jest.fn(),
    read: jest.fn(),
    write: jest.fn(),
} as unknown as jest.Mocked<VaultFileAdapter>;

describe('RuntimeSettingsStorage', () => {
    let storage: RuntimeSettingsStorage;

    beforeEach(() => {
        jest.clearAllMocks();
        storage = new RuntimeSettingsStorage(mockAdapter);
    });

    describe('load', () => {
        it('should return defaults if file does not exist', async () => {
            mockAdapter.exists.mockResolvedValue(false);
            const result = await storage.load();
            expect(result.permissions).toBeDefined();
        });

        it('should load and parse allowed permissions', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue(JSON.stringify({
                permissions: {
                    allow: ['tool1'],
                    deny: [],
                    ask: []
                }
            }));

            const result = await storage.load();
            expect(result.permissions?.allow).toContain('tool1');
        });

        it('should throw on read error', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockRejectedValue(new Error('Read failed'));

            await expect(storage.load()).rejects.toThrow('Read failed');
        });
    });

    describe('addAllowRule', () => {
        it('should add rule to allow list and save', async () => {
            // Setup initial state
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue(JSON.stringify({
                permissions: { allow: [], deny: [], ask: [] }
            }));

            await storage.addAllowRule(createPermissionRule('new-rule'));

            const writeCall = mockAdapter.write.mock.calls[0];
            const writtenContent = JSON.parse(writeCall[1]);
            expect(writtenContent.permissions.allow).toContain('new-rule');
        });

        it('should not duplicate existing rule', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue(JSON.stringify({
                permissions: { allow: ['existing'], deny: [], ask: [] }
            }));

            await storage.addAllowRule(createPermissionRule('existing'));

            expect(mockAdapter.write).not.toHaveBeenCalled();
        });
    });

    describe('removeRule', () => {
        it('should remove rule from all lists', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue(JSON.stringify({
                permissions: {
                    allow: ['rule1'],
                    deny: ['rule1'],
                    ask: ['rule1']
                }
            }));

            await storage.removeRule(createPermissionRule('rule1'));

            expect(mockAdapter.write).toHaveBeenCalledWith(
                RUNTIME_SETTINGS_PATH,
                expect.stringContaining('"allow": []')
            );
        });
    });

    describe('addDenyRule', () => {
        it('should add rule to deny list and save', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue(JSON.stringify({
                permissions: { allow: [], deny: [], ask: [] }
            }));

            await storage.addDenyRule(createPermissionRule('dangerous-rule'));

            const writeCall = mockAdapter.write.mock.calls[0];
            const writtenContent = JSON.parse(writeCall[1]);
            expect(writtenContent.permissions.deny).toContain('dangerous-rule');
        });

        it('should not duplicate existing deny rule', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue(JSON.stringify({
                permissions: { allow: [], deny: ['existing'], ask: [] }
            }));

            await storage.addDenyRule(createPermissionRule('existing'));

            expect(mockAdapter.write).not.toHaveBeenCalled();
        });
    });

    describe('addAskRule', () => {
        it('should add rule to ask list and save', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue(JSON.stringify({
                permissions: { allow: [], deny: [], ask: [] }
            }));

            await storage.addAskRule(createPermissionRule('ask-rule'));

            const writeCall = mockAdapter.write.mock.calls[0];
            const writtenContent = JSON.parse(writeCall[1]);
            expect(writtenContent.permissions.ask).toContain('ask-rule');
        });

        it('should not duplicate existing ask rule', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue(JSON.stringify({
                permissions: { allow: [], deny: [], ask: ['existing'] }
            }));

            await storage.addAskRule(createPermissionRule('existing'));

            expect(mockAdapter.write).not.toHaveBeenCalled();
        });
    });

    describe('save', () => {
        it('should handle parse error on existing file', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue('invalid json{{{');

            await storage.save({
                permissions: { allow: [], deny: [], ask: [] }
            });

            // Should still write successfully after parse error
            expect(mockAdapter.write).toHaveBeenCalled();
            const writeCall = mockAdapter.write.mock.calls[0];
            const writtenContent = JSON.parse(writeCall[1]);
            expect(writtenContent.permissions).toEqual({ allow: [], deny: [], ask: [] });
        });

    });

    describe('load edge cases', () => {
        it('normalizes unsupported permission arrays to defaults', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue(JSON.stringify({
                permissions: [
                    { toolName: 'Bash', pattern: 'git *', approvedAt: 1000, scope: 'always' },
                ],
            }));

            const result = await storage.load();
            expect(result.permissions).toEqual({
                allow: [],
                deny: [],
                ask: [],
                defaultMode: undefined,
                additionalDirectories: undefined,
            });
        });

        it('should normalize invalid permissions to defaults', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue(JSON.stringify({
                permissions: 'not-an-object',
            }));

            const result = await storage.load();
            expect(result.permissions?.allow).toEqual([]);
            expect(result.permissions?.deny).toEqual([]);
            expect(result.permissions?.ask).toEqual([]);
        });

        it('should filter non-string values from permission arrays', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue(JSON.stringify({
                permissions: {
                    allow: ['valid', 123, null, 'also-valid'],
                    deny: [true, 'deny-rule'],
                    ask: [],
                },
            }));

            const result = await storage.load();
            expect(result.permissions?.allow).toEqual(['valid', 'also-valid']);
            expect(result.permissions?.deny).toEqual(['deny-rule']);
        });

        it('should preserve additionalDirectories and defaultMode', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue(JSON.stringify({
                permissions: {
                    allow: [],
                    deny: [],
                    ask: [],
                    defaultMode: 'bypassPermissions',
                    additionalDirectories: ['/extra/dir'],
                },
            }));

            const result = await storage.load();
            expect(result.permissions?.defaultMode).toBe('bypassPermissions');
            expect(result.permissions?.additionalDirectories).toEqual(['/extra/dir']);
        });
    });

    describe('isLegacyPermissionsFormat edge cases', () => {
        it('should return false for null data', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue(JSON.stringify({
                permissions: null,
            }));

            const result = await storage.load();
            // null permissions normalized to defaults
            expect(result.permissions?.allow).toEqual([]);
        });

        it('should return false for non-object permissions', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue(JSON.stringify({
                permissions: 42,
            }));

            const result = await storage.load();
            expect(result.permissions?.allow).toEqual([]);
            expect(result.permissions?.deny).toEqual([]);
        });

        it('should return false for empty array permissions', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue(JSON.stringify({
                permissions: [],
            }));

            const result = await storage.load();
            // Empty array is legacy format but length === 0, so falls through
            expect(result.permissions?.allow).toEqual([]);
        });
    });

    describe('normalizePermissions edge cases', () => {
        it('should handle non-array allow/deny/ask values', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue(JSON.stringify({
                permissions: {
                    allow: 'not-an-array',
                    deny: 123,
                    ask: null,
                },
            }));

            const result = await storage.load();
            expect(result.permissions?.allow).toEqual([]);
            expect(result.permissions?.deny).toEqual([]);
            expect(result.permissions?.ask).toEqual([]);
        });
    });

    describe('save edge cases', () => {
        it('should use default permissions when settings.permissions is undefined', async () => {
            mockAdapter.exists.mockResolvedValue(false);

            await storage.save({} as any);

            const writeCall = mockAdapter.write.mock.calls[0];
            const writtenContent = JSON.parse(writeCall[1]);
            expect(writtenContent.permissions).toEqual({
                allow: [],
                deny: [],
                ask: [],
            });
        });
    });

    describe('getPermissions edge cases', () => {
        it('should return default permissions when settings has no permissions field', async () => {
            mockAdapter.exists.mockResolvedValue(true);
            mockAdapter.read.mockResolvedValue(JSON.stringify({}));

            const result = await storage.getPermissions();
            expect(result.allow).toEqual([]);
            expect(result.deny).toEqual([]);
            expect(result.ask).toEqual([]);
        });
    });

});
