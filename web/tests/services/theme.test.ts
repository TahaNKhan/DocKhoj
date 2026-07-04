import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { getStoredTheme, applyTheme, setTheme } from '../../src/services/theme';

const KEY = 'dockhoj:theme';

describe('theme service', () => {
  beforeEach(() => {
    localStorage.removeItem(KEY);
    document.documentElement.dataset.theme = '';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getStoredTheme', () => {
    it('returns "light" when stored in localStorage', () => {
      localStorage.setItem(KEY, 'light');
      expect(getStoredTheme()).toBe('light');
    });

    it('returns "dark" when stored in localStorage', () => {
      localStorage.setItem(KEY, 'dark');
      expect(getStoredTheme()).toBe('dark');
    });

    it('falls back to OS preference when nothing is stored', () => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query.includes('light'),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      expect(getStoredTheme()).toBe('light');
    });

    it('falls back to "dark" when nothing is stored and OS prefers dark', () => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query.includes('dark'),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      expect(getStoredTheme()).toBe('dark');
    });

    it('ignores invalid stored values and falls through to OS preference', () => {
      localStorage.setItem(KEY, 'invalid');
      vi.stubGlobal('matchMedia', () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      expect(getStoredTheme()).toBe('dark');
    });
  });

  describe('applyTheme', () => {
    it('sets data-theme on documentElement', () => {
      applyTheme('light');
      expect(document.documentElement.dataset.theme).toBe('light');
    });

    it('sets data-theme to "dark"', () => {
      applyTheme('dark');
      expect(document.documentElement.dataset.theme).toBe('dark');
    });
  });

  describe('setTheme', () => {
    it('applies the theme and persists it', () => {
      setTheme('light');
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(localStorage.getItem(KEY)).toBe('light');
    });

    it('applies "dark" and persists it', () => {
      setTheme('dark');
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(localStorage.getItem(KEY)).toBe('dark');
    });
  });
});
