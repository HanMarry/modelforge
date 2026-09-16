import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

/**
 * oneDark tuned for better comment contrast. Used for markdown code blocks, which sit on the
 * dark code-block surface in both themes.
 */
export const customOneDarkTheme = {
  ...oneDark,
  'code[class*="language-"]': {
    ...oneDark['code[class*="language-"]'],
    color: '#e6e6e6',
    fontSize: '14px',
  },
  'pre[class*="language-"]': {
    ...oneDark['pre[class*="language-"]'],
    color: '#e6e6e6',
    fontSize: '14px',
  },
  comment: { ...oneDark.comment, color: '#a0a0a0', fontStyle: 'italic' },
  prolog: { ...oneDark.prolog, color: '#a0a0a0' },
  doctype: { ...oneDark.doctype, color: '#a0a0a0' },
  cdata: { ...oneDark.cdata, color: '#a0a0a0' },
};

/**
 * Light counterpart for the file viewer. The viewer paints on the panel surface, so a dark
 * syntax palette there turns into neon-on-white; this keeps contrast readable in light mode.
 */
export const customOneLightTheme = {
  ...oneLight,
  'code[class*="language-"]': {
    ...oneLight['code[class*="language-"]'],
    color: '#24292f',
    fontSize: '14px',
  },
  'pre[class*="language-"]': {
    ...oneLight['pre[class*="language-"]'],
    color: '#24292f',
    fontSize: '14px',
  },
  comment: { ...oneLight.comment, color: '#6a737d', fontStyle: 'italic' },
  prolog: { ...oneLight.prolog, color: '#6a737d' },
  doctype: { ...oneLight.doctype, color: '#6a737d' },
  cdata: { ...oneLight.cdata, color: '#6a737d' },
  string: { ...oneLight.string, color: '#0a7d3f' },
  number: { ...oneLight.number, color: '#b45309' },
  keyword: { ...oneLight.keyword, color: '#8250df' },
  function: { ...oneLight.function, color: '#1f5fa8' },
  operator: { ...oneLight.operator, color: '#57606a' },
  punctuation: { ...oneLight.punctuation, color: '#57606a' },
};

export function syntaxThemeFor(isDark: boolean) {
  return isDark ? customOneDarkTheme : customOneLightTheme;
}
