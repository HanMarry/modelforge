import { describe, expect, it } from 'vitest';
import { errorMessage } from './conversionUtils';

describe('errorMessage', () => {
  it('prefers ACP JSON-RPC error data over generic messages', () => {
    expect(
      errorMessage({
        error: {
          message: 'Invalid params',
          data: 'MLX backend error: failed to load model',
        },
      })
    ).toBe('MLX backend error: failed to load model');
  });

  it('prefers ACP JSON-RPC error data from Error instances', () => {
    const error = Object.assign(new Error('Invalid params'), {
      error: {
        message: 'Invalid params',
        data: 'MLX backend error: failed to load model',
      },
    });

    expect(errorMessage(error)).toBe('MLX backend error: failed to load model');
  });

  it('uses the message of structured ACP error data', () => {
    expect(
      errorMessage({
        code: -32603,
        message: 'Internal error',
        data: {
          code: 'CREDENTIAL_WRITE_FAILED',
          provider: 'Gateway',
          message: 'CREDENTIAL_WRITE_FAILED: provider Gateway: keyring locked',
        },
      })
    ).toBe('CREDENTIAL_WRITE_FAILED: provider Gateway: keyring locked');
  });

  it('falls back to the error message when structured data has no message', () => {
    expect(
      errorMessage({ code: -32603, message: 'Add credits', data: { reason: 'credits_exhausted' } })
    ).toBe('Add credits');
  });
});
