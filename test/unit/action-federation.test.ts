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

  it('builds an Anthropic exchange backed by GitHub OIDC tokens', async () => {
    const core = actionCore({ ...FULL, anthropic_workspace_id: 'wrkspc_1' });
    const config = federationFromActionInput(core)!;

    expect(config.exchange).toEqual({
      type: 'anthropic',
      federationRuleId: 'fdrl_1',
      organizationId: 'org-uuid',
      serviceAccountId: 'svac_1',
      workspaceId: 'wrkspc_1',
    });
    expect(config.audience).toBeUndefined();
    expect(await config.getIdentityToken('aud')).toBe('gh-jwt');
    expect(core.getIDToken).toHaveBeenCalledWith('aud');
  });

  it('passes a custom audience through and leaves workspace unset when omitted', () => {
    const config = federationFromActionInput(actionCore({ ...FULL, oidc_audience: 'custom-aud' }))!;

    expect(config.audience).toBe('custom-aud');
    expect(config.exchange.workspaceId).toBeUndefined();
  });

  it('explains missing id-token permission when the OIDC request fails', async () => {
    const core = actionCore(
      FULL,
      vi.fn(async () => {
        throw new Error('Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable');
      }),
    );
    const config = federationFromActionInput(core)!;

    await expect(config.getIdentityToken('aud')).rejects.toThrow(/id-token: write/);
  });
});
