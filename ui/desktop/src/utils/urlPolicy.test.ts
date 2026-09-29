import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../test/pbt';
import { isAllowedUrl } from './urlPolicy';

// Feature: mathmodel-parity-and-beyond, Property 27: 浏览器 URL 协议白名单
describe('Property 27: 浏览器 URL 协议白名单', () => {
  it('accepts only parseable http/https URLs', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        fc.oneof(fc.constant('http'), fc.constant('https'), fc.constant('ftp')),
        fc.boolean(),
        (suffix, scheme, upper) => {
          const url = upper ? `${scheme.toUpperCase()}://example.com/${suffix}` : `${scheme}://example.com/${suffix}`;
          expect(isAllowedUrl(url)).toBe(scheme === 'http' || scheme === 'https');
        }
      ),
      pbtParams
    );
  });

  it('rejects dangerous and unparseable inputs', () => {
    const blocked = [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'chrome://settings',
      'about:blank',
      'vbscript:msgbox',
      '',
      '   ',
      'not a url',
      'httpx://example.com',
    ];
    for (const input of blocked) {
      expect(isAllowedUrl(input)).toBe(false);
    }
    expect(isAllowedUrl('https://mcm.edu.cn/')).toBe(true);
    expect(isAllowedUrl('http://example.com')).toBe(true);
  });
});
