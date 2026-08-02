import type {
  PermissionUpdate,
  RewindFilesResult,
} from '@/core/runtime/contracts';

describe('runtime contracts', () => {
  it('represents successful and failed rewind outcomes', () => {
    const ok: RewindFilesResult = { canRewind: true, filesChanged: [] };
    const denied: RewindFilesResult = { canRewind: false, error: 'not available' };

    expect(ok.canRewind).toBe(true);
    expect(denied.canRewind).toBe(false);
  });

  it('keeps permission updates destination-safe', () => {
    const update: PermissionUpdate = {
      type: 'addRules',
      behavior: 'allow',
      destination: 'projectSettings',
      rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
    };

    expect(update.destination).toBe('projectSettings');
  });
});
