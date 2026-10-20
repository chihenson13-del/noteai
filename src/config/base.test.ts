import { describe, expect, it } from 'vitest';
import { appUrl, normalizeBase, routerBasename } from './base';

describe('base path', () => {
  it('normalizes whatever the build tool provides', () => {
    expect(normalizeBase(undefined)).toBe('/');
    expect(normalizeBase('')).toBe('/');
    expect(normalizeBase('./')).toBe('/');
    expect(normalizeBase('/')).toBe('/');
    expect(normalizeBase('eapartner')).toBe('/eapartner/');
    expect(normalizeBase('/eapartner')).toBe('/eapartner/');
    expect(normalizeBase('/eapartner/')).toBe('/eapartner/');
  });

  it('gives React Router a basename without a trailing slash (none at the root)', () => {
    expect(routerBasename('/')).toBeUndefined();
    expect(routerBasename('/eapartner/')).toBe('/eapartner');
  });

  it('builds absolute app URLs under the base', () => {
    expect(appUrl('/s/abc', 'https://example.com', '/')).toBe('https://example.com/s/abc');
    expect(appUrl('/s/abc', 'https://u.github.io', '/eapartner/')).toBe('https://u.github.io/eapartner/s/abc');
    expect(appUrl('s/abc', 'https://u.github.io', '/eapartner/')).toBe('https://u.github.io/eapartner/s/abc');
    expect(appUrl('/', 'https://u.github.io', '/eapartner/')).toBe('https://u.github.io/eapartner/');
  });
});
