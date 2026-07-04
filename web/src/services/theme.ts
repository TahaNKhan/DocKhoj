type Theme = 'dark' | 'light';

const KEY = 'dockhoj:theme';

export const getStoredTheme = (): Theme => {
  const stored = localStorage.getItem(KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
};

export const applyTheme = (theme: Theme) => {
  document.documentElement.dataset.theme = theme;
};

export const setTheme = (theme: Theme) => {
  applyTheme(theme);
  localStorage.setItem(KEY, theme);
};
