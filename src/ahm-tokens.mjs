import { getTheme } from "./themes.mjs";

const ENTITY_STATE_TO_THEME_STATE = {
  healthy: "healthy",
  degraded: "degraded",
  unhealthy: "unhealthy",
  unknown: "unknown",
  standby: "alt",
};

const SIGNAL_STATE_TO_THEME_STATE = {
  healthy: "healthy",
  degraded: "degraded",
  unhealthy: "unhealthy",
  unknown: "unknown",
};

export const AHM_ENTITY_STATES = Object.freeze(["healthy", "degraded", "unhealthy", "unknown", "standby"]);
export const AHM_SIGNAL_STATES = Object.freeze(["healthy", "degraded", "unhealthy", "unknown"]);

const CANVAS_COLOR_KEYS = Object.freeze(["ink", "muted", "bg"]);
const STATE_COLOR_KEYS = Object.freeze(["border", "fill", "accent"]);
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectKnownKeys(path, value, allowedKeys) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`unsupported color override key "${path}.${key}"`);
    }
  }
}

function expectColor(path, value) {
  if (typeof value !== "string" || !HEX_COLOR_RE.test(value)) {
    throw new Error(`invalid color literal for "${path}"`);
  }
}

export function getAhmPalette(themeName = "portal", colors) {
  const theme = getTheme(themeName);
  const entity = {};
  for (const [state, themeState] of Object.entries(ENTITY_STATE_TO_THEME_STATE)) {
    const token = theme.state[themeState];
    entity[state] = {
      border: token.border,
      fill: token.fill,
      accent: token.dot,
      dash: token.dash ?? null,
    };
  }
  const signal = {};
  for (const [state, themeState] of Object.entries(SIGNAL_STATE_TO_THEME_STATE)) {
    const token = theme.state[themeState];
    signal[state] = {
      border: token.border,
      fill: token.fill,
      accent: token.dot,
      text: token.text ?? token.dot,
      dash: token.dash ?? null,
    };
  }

  // validate color-only overrides before applying them
  if (colors !== undefined) {
    if (!isObject(colors)) throw new Error("colors override must be an object");
    expectKnownKeys("colors", colors, ["canvas", "entity", "signal"]);

    if (colors.canvas !== undefined) {
      if (!isObject(colors.canvas)) throw new Error("colors.canvas must be an object");
      expectKnownKeys("canvas", colors.canvas, CANVAS_COLOR_KEYS);
      for (const [key, value] of Object.entries(colors.canvas)) {
        expectColor(`canvas.${key}`, value);
      }
    }

    if (colors.entity !== undefined) {
      if (!isObject(colors.entity)) throw new Error("colors.entity must be an object");
      for (const [state, tokenOverride] of Object.entries(colors.entity)) {
        if (!AHM_ENTITY_STATES.includes(state)) {
          throw new Error(`unsupported entity state override "${state}"`);
        }
        if (!isObject(tokenOverride)) throw new Error(`colors.entity.${state} must be an object`);
        expectKnownKeys(`entity.${state}`, tokenOverride, STATE_COLOR_KEYS);
        for (const [key, value] of Object.entries(tokenOverride)) {
          expectColor(`entity.${state}.${key}`, value);
        }
      }
    }

    if (colors.signal !== undefined) {
      if (!isObject(colors.signal)) throw new Error("colors.signal must be an object");
      for (const [state, tokenOverride] of Object.entries(colors.signal)) {
        if (!AHM_SIGNAL_STATES.includes(state)) {
          throw new Error(`unsupported signal state override "${state}"`);
        }
        if (!isObject(tokenOverride)) throw new Error(`colors.signal.${state} must be an object`);
        expectKnownKeys(`signal.${state}`, tokenOverride, STATE_COLOR_KEYS);
        for (const [key, value] of Object.entries(tokenOverride)) {
          expectColor(`signal.${state}.${key}`, value);
        }
      }
    }
  }
  const overrides = colors ?? {};

  const result = {
    theme: theme.name,
    canvas: { ink: theme.ink, muted: theme.muted, bg: theme.bg },
    entity: {},
    signal: {},
  };
  if (overrides.canvas) Object.assign(result.canvas, overrides.canvas);
  for (const state of Object.keys(entity)) {
    result.entity[state] = { ...entity[state], ...(overrides.entity?.[state] ?? {}), dash: entity[state].dash ?? null };
  }
  // an accent override also colors the signal text, as it did before themes carried `text`
  for (const state of Object.keys(signal)) {
    const override = overrides.signal?.[state] ?? {};
    result.signal[state] = { ...signal[state], ...override, text: override.accent ?? signal[state].text, dash: signal[state].dash ?? null };
  }
  return result;
}

function cssBlock(selector, palette) {
  return [
    `${selector} .state-healthy {`,
    `  color: ${palette.entity.healthy.accent};`,
    `}`,
    ``,
    `${selector} .state-degraded {`,
    `  color: ${palette.entity.degraded.accent};`,
    `}`,
    ``,
    `${selector} .state-unhealthy {`,
    `  color: ${palette.entity.unhealthy.accent};`,
    `}`,
    ``,
    `${selector} .state-unknown {`,
    `  color: ${palette.entity.unknown.accent};`,
    `}`,
    ``,
    `${selector} .state-standby {`,
    `  color: ${palette.entity.standby.accent};`,
    `}`,
  ].join("\n");
}

export function getAhmCss() {
  const portal = getAhmPalette("portal");
  const midnight = getAhmPalette("midnight");
  const candy = getAhmPalette("candy");
  const slate = getAhmPalette("slate");

  return [
    ".ahm-root {",
    '  font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif;',
    "}",
    "",
    cssBlock(".ahm-root", portal),
    "",
    cssBlock('.ahm-root[data-ahm-theme="midnight"]', midnight),
    "",
    cssBlock('.ahm-root[data-ahm-theme="candy"]', candy),
    "",
    cssBlock('.ahm-root[data-ahm-theme="slate"]', slate),
    "",
  ].join("\n");
}

export function normalizeEntityState(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!AHM_ENTITY_STATES.includes(normalized)) {
    throw new Error(`unsupported entity state "${value}"`);
  }
  return normalized;
}

export function stateLabel(state) {
  return String(state).slice(0, 1).toUpperCase() + String(state).slice(1);
}
