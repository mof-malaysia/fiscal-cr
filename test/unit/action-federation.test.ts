import { describe, expect, it, vi } from 'vitest';
import { federationFromActionInput } from '../../action/federation.js';
import { ConfigError } from '../../src/utils/errors.js';

function actionCore(inputs: Record<string, string>, idToken = vi.fn(async () => 'gh-jwt')) {
  return {
    getInput: vi.fn((name: string) => inputs[name] ?? ''),
    getIDToken: idToken,
  };
}

const FULL = {
  anthropic_federation_rule_id: 'fdrl_1',
  anthropic_organization_id: 'org-uuid',
  anthropic_service_account_id: 'svac_1',
};

describe('Action anthropic federation inputs', () => {
  it('returns undefined when no federation inputs are set', () => {
    expect(federationFromActionInput(actionCore({}))).toBeUndefined();
  });

  it('throws ConfigError when required inputs are partially set', () => {
    expect(() =>
      federationFromActionInput(actionCore({ anthropic_federation_rule_id: 'fdrl_1' })),
    ).toThrowError(/missing anthropic_organization_id, anthropic_service_account_id/);
  });

  it('throws ConfigError when only the workspace is set', () => {
    expect(() =>
      federationFromActionInput(actionCore({ anthropic_workspace_id: 'wrkspc_1' })),
    ).toThrowError(ConfigError);
  });

  it('builds the config and mints a GitHub OIDC token for the default audience', async () => {
    const core = actionCore({ ...FULL, anthropic_workspace_id: 'wrkspc_1' });
    const config = federationFromActionInput(core)!;

    expect(config).toMatchObject({
      federationRuleId: 'fdrl_1',
      organizationId: 'org-uuid',
      serviceAccountId: 'svac_1',
      workspaceId: 'wrkspc_1',
    });
    expect(await config.getIdentityToken()).toBe('gh-jwt');
    expect(core.getIDToken).toHaveBeenCalledWith('https://api.anthropic.com');
  });

  it('honors a custom audience and leaves workspace unset when omitted', async () => {
    const core = actionCore({ ...FULL, oidc_audience: 'custom-aud' });
    const config = federationFromActionInput(core)!;

    expect(config.workspaceId).toBeUndefined();
    await config.getIdentityToken();
    expect(core.getIDToken).toHaveBeenCalledWith('custom-aud');
  });

  it('explains missing id-token permission when the OIDC request fails', async () => {
    const core = actionCore(
      FULL,
      vi.fn(async () => {
        throw new Error('Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable');
      }),
    );
    const config = federationFromActionInput(core)!;

    await expect(config.getIdentityToken()).rejects.toThrow(/id-token: write/);
  });
});
