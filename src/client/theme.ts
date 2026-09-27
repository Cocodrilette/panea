import type { ITheme } from '@xterm/xterm'

export type ThemePref = 'system' | 'light' | 'dark'
export type ThemeName = 'light' | 'dark'

const STORAGE_KEY = 'tcv:theme'

const DARK: ITheme = {
  background: '#14161c',
  foreground: '#d7dae1',
  cursor: '#6ea8fe',
  cursorAccent: '#14161c',
  selectionBackground: '#31405e',
  black: '#22252d',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#c7ccd6',
  brightBlack: '#5c6370',
  brightRed: '#ef7a83',
  brightGreen: '#a9d47f',
  brightYellow: '#f0cd8b',
  brightBlue: '#7cc0ff',
  brightMagenta: '#d98ceb',
  brightCyan: '#69c8d3',
  brightWhite: '#e6e9ef',
}

/**
 * Every ANSI color here clears 4.5:1 against the white background. Programs
 * pick colors assuming a dark terminal, so "white" and "yellow" in particular
 * have to become greys and ambers, or `ls` and prompts vanish.
 */
const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#0969da',
  cursorAccent: '#ffffff',
  selectionBackground: '#b6d6fb',
  selectionInactiveBackground: '#dde3ea',
  black: '#24292f',
  red: '#c4262e',
  green: '#1a7f37',
  yellow: '#8a5a00',
  blue: '#0550ae',
  magenta: '#8250df',
  cyan: '#0b6e7d',
  white: '#5f6873',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#116329',
  brightYellow: '#6f4700',
  brightBlue: '#0969da',
  brightMagenta: '#6639ba',
  brightCyan: '#07575f',
  brightWhite: '#424a53',
}

export interface TermTheme {
  theme: ITheme
  /**
   * xterm nudges any foreground that falls under this ratio against its cell
   * background. The palette above covers the 16 named colors; this catches
   * the 256-color and truecolor output (Claude Code, delta, bat) that was
   * tuned for a dark screen.
   */
  minimumContrastRatio: number
}

export function termTheme(name: ThemeName): TermTheme {
  return name === 'light' ? { theme: LIGHT, minimumContrastRatio: 4.5 } : { theme: DARK, minimumContrastRatio: 1 }
}

const media = window.matchMedia('(prefers-color-scheme: light)')
const listeners = new Set<(name: ThemeName) => void>()

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // Storage blocked: fall through to following the OS.
  }
  return 'system'
}

let pref: ThemePref = readPref()

export function themePref(): ThemePref {
  return pref
}

export function currentTheme(): ThemeName {
  if (pref !== 'system') return pref
  return media.matches ? 'light' : 'dark'
}

function apply(): void {
  const name = currentTheme()
  document.documentElement.dataset.theme = name
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', name === 'light' ? '#f4f5f7' : '#0c0d11')
  listeners.forEach((fn) => fn(name))
}

export function setThemePref(next: ThemePref): void {
  pref = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Not persisted; still applies for this session.
  }
  apply()
}

export function onThemeChange(fn: (name: ThemeName) => void): void {
  listeners.add(fn)
}

media.addEventListener('change', () => {
  if (pref === 'system') apply()
})

apply()
