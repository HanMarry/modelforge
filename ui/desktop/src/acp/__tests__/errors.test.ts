import { describe, expect, it } from 'vitest';
import { RequestError } from '@agentclientprotocol/sdk';
import { formatAcpError, parseAcpCreditsExhaustedError, parseAcpProviderError } from '../errors';

const secretUnresolved = {
  code: -32603,
  message: 'Gateway: credential for header Authorization unresolved: no credential is stored for it',
  data: {
    code: 'SECRET_UNRESOLVED',
    provider: 'Gateway',
    header: 'Authorization',
    reason: 'no credential is stored for it',
    message:
      'Gateway: credential for header Authorization unresolved: no credential is stored for it',
  },
};

describe('formatAcpError', () => {
  it('explains how to recover from an authentication error', () => {
    expect(formatAcpError(RequestError.authRequired())).toBe(
      'Sign in to your provider, then try again.'
    );
  });

  it('names the provider and header whose credential cannot be resolved', () => {
    const text = formatAcpError(secretUnresolved);

    expect(text).toContain('"Gateway"');
    expect(text).toContain('"Authorization"');
    expect(text).toContain('no credential is stored for it');
  });
});

describe('parseAcpProviderError', () => {
  it('parses unresolved header credentials', () => {
    expect(parseAcpProviderError({ error: secretUnresolved })).toEqual({
      code: 'SECRET_UNRESOLVED',
      provider: 'Gateway',
      header: 'Authorization',
      reason: 'no credential is stored for it',
      message:
        'Gateway: credential for header Authorization unresolved: no credential is stored for it',
    });
  });

  it('parses save failures without a header', () => {
    expect(
      parseAcpProviderError({
        code: -32603,
        message: 'CREDENTIAL_WRITE_FAILED: provider Gateway: keyring locked',
        data: {
          code: 'CREDENTIAL_WRITE_FAILED',
          provider: 'Gateway',
          reason: 'keyring locked',
          message: 'CREDENTIAL_WRITE_FAILED: provider Gateway: keyring locked',
        },
      })
    ).toEqual({
      code: 'CREDENTIAL_WRITE_FAILED',
      provider: 'Gateway',
      reason: 'keyring locked',
      message: 'CREDENTIAL_WRITE_FAILED: provider Gateway: keyring locked',
    });
  });

  it('ignores other structured errors', () => {
    expect(
      parseAcpProviderError({
        code: -32603,
        message: 'Add credits to continue.',
        data: { reason: 'credits_exhausted' },
      })
    ).toBeNull();
    expect(parseAcpProviderError(new Error('plain'))).toBeNull();
  });
});

describe('parseAcpCreditsExhaustedError', () => {
  it('parses structured ACP credits exhausted errors', () => {
    expect(
      parseAcpCreditsExhaustedError({
        code: -32603,
        message: 'Please add credits to your account, then resend your message to continue.',
        data: {
          reason: 'credits_exhausted',
          url: 'https://router.tetrate.ai/billing',
        },
      })
    ).toEqual({
      message: 'Please add credits to your account, then resend your message to continue.',
      url: 'https://router.tetrate.ai/billing',
    });
  });

  it('parses wrapped JSON-RPC errors', () => {
    expect(
      parseAcpCreditsExhaustedError({
        error: {
          code: -32603,
          message: 'Add credits to continue.',
          data: {
            reason: 'credits_exhausted',
          },
        },
      })
    ).toEqual({
      message: 'Add credits to continue.',
    });
  });

  it('ignores non-credits-exhausted errors', () => {
    expect(
      parseAcpCreditsExhaustedError({
        code: -32603,
        message: 'Something failed.',
        data: {
          reason: 'provider_error',
        },
      })
    ).toBeNull();
  });
});
