// icons.mjs — clean, original, professional service glyphs (48x48 viewBox), Azure-blue palette.
// Pluggable: azure-arch.mjs will inline icons/<key>.svg from disk when present (drop in the official
// Microsoft Azure architecture icons for exact branding — their license permits documentation/diagram
// use, unmodified). These originals are the license-clean fallback so the diagram renders standalone.

const AZ = "#0078D4";      // azure blue
const AZ2 = "#50b0e8";     // light azure
const AZ_DK = "#005a9e";
const TEAL = "#3fb0ac";
const GOLD = "#f2c811";
const PURPLE = "#8661c5";
const GREY = "#8a8886";

export const ICON_KEYS = [
  "user", "dns", "appgw-waf", "private-endpoint", "vnic", "sql", "keyvault",
  "storage", "entra", "appinsights", "monitor", "appservice", "managed-identity",
  "shield", "vnet", "subnet",
];

// each returns inner SVG markup drawn in a 0 0 48 48 coordinate space
export function iconSvg(key) {
  const F = {
    user: () => `
      <circle cx="24" cy="17" r="8" fill="${AZ2}"/>
      <path d="M9 41c0-8.3 6.7-14 15-14s15 5.7 15 14z" fill="${AZ}"/>`,

    dns: () => `
      <rect x="10" y="12" width="26" height="26" rx="2" fill="#eef4fb" stroke="${GREY}" stroke-width="1.4"/>
      <rect x="13.5" y="8.5" width="26" height="26" rx="2" fill="#f7fafd" stroke="${GREY}" stroke-width="1.4"/>
      <circle cx="26.5" cy="21.5" r="9" fill="${AZ}"/>
      <path d="M17.5 21.5h18M26.5 12.5c4 3.5 4 14.5 0 18M26.5 12.5c-4 3.5-4 14.5 0 18" fill="none" stroke="#fff" stroke-width="1.3"/>`,

    "appgw-waf": () => `
      <path d="M8 24l7-7 7 7-7 7z" fill="${TEAL}"/>
      <path d="M15 17l7-7 7 7-7 7zM15 31l7-7 7 7-7 7z" fill="#7cc576"/>
      <circle cx="31" cy="17" r="8" fill="${AZ}"/>
      <path d="M24 17h14M31 10c3.5 3 3.5 11 0 14M31 10c-3.5 3-3.5 11 0 14" fill="none" stroke="#fff" stroke-width="1.1"/>
      <g transform="translate(26,26)">
        <rect x="0" y="0" width="18" height="14" rx="1.5" fill="#c94f3d"/>
        <path d="M0 4.7h18M0 9.3h18M6 0v4.7M12 4.7v4.6M6 9.3V14M12 9.3V14M3 4.7V0M9 9.3V4.7M15 4.7V0" stroke="#fff" stroke-width="1"/>
      </g>`,

    "private-endpoint": () => `
      <path d="M18 15a7 7 0 0 0 0 18" fill="none" stroke="${AZ}" stroke-width="3.4" stroke-linecap="round"/>
      <path d="M30 15a7 7 0 0 1 0 18" fill="none" stroke="${AZ}" stroke-width="3.4" stroke-linecap="round"/>
      <path d="M20 24h8" stroke="${AZ}" stroke-width="3.4" stroke-linecap="round"/>
      <circle cx="24" cy="12" r="3.6" fill="${AZ_DK}"/>`,

    vnic: () => `
      <rect x="9" y="14" width="24" height="20" rx="2" fill="${AZ}"/>
      <path d="M13 34v5M18 34v5M23 34v5M28 34v5" stroke="${GREY}" stroke-width="1.6"/>
      <rect x="13" y="18" width="16" height="12" rx="1" fill="#eaf3fb"/>
      <circle cx="36" cy="16" r="4" fill="${AZ2}"/><path d="M33 16h6M36 13v6" stroke="#fff" stroke-width="1"/>`,

    sql: () => `
      <path d="M14 27a12 8 0 1 1 20 3h1a6 6 0 0 1 0 12H16a8 8 0 0 1-2-15z" fill="${AZ2}"/>
      <text x="24" y="35" font-family="Segoe UI, Arial" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">SQL</text>`,

    keyvault: () => `
      <circle cx="24" cy="24" r="15" fill="#fff" stroke="${GOLD}" stroke-width="2.4"/>
      <circle cx="20" cy="20" r="5.5" fill="none" stroke="${GOLD}" stroke-width="3"/>
      <path d="M23.5 23.5l8 8M28 28l-2.5 2.5M31 31l-2.5 2.5" stroke="${GOLD}" stroke-width="3" stroke-linecap="round"/>`,

    storage: () => `
      <rect x="9" y="12" width="30" height="24" rx="2" fill="#eef7f6" stroke="${TEAL}" stroke-width="1.4"/>
      <rect x="12" y="15.5" width="24" height="4.4" rx="1" fill="${TEAL}"/>
      <rect x="12" y="21.8" width="24" height="4.4" rx="1" fill="#9ad6d3"/>
      <rect x="12" y="28.1" width="24" height="4.4" rx="1" fill="${TEAL}"/>`,

    entra: () => `
      <path d="M24 8l14 28H10z" fill="${AZ}"/>
      <path d="M24 8l14 28H24z" fill="${AZ_DK}"/>
      <path d="M24 19l7 14H17z" fill="#fff" opacity="0.9"/>`,

    appinsights: () => `
      <path d="M24 8a12 12 0 0 1 7 21.7c-1.4 1-2 1.8-2 3.3H19c0-1.5-.6-2.3-2-3.3A12 12 0 0 1 24 8z" fill="${PURPLE}"/>
      <rect x="19" y="34" width="10" height="4" rx="1" fill="${GREY}"/>
      <path d="M20 38h8" stroke="${GREY}" stroke-width="1.6"/>
      <path d="M21 20l3 4 4-7" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,

    monitor: () => `
      <circle cx="24" cy="24" r="15" fill="#eaf3fb" stroke="${AZ}" stroke-width="1.6"/>
      <path d="M24 24l8-6" stroke="${AZ_DK}" stroke-width="2.2" stroke-linecap="round"/>
      <circle cx="24" cy="24" r="2.6" fill="${AZ_DK}"/>
      <path d="M13 24a11 11 0 0 1 22 0" fill="none" stroke="${AZ}" stroke-width="2" stroke-dasharray="1.5 3"/>`,

    appservice: () => `
      <circle cx="24" cy="24" r="15" fill="${AZ2}"/>
      <path d="M9 24h30M24 9c5 4 5 26 0 30M24 9c-5 4-5 26 0 30" fill="none" stroke="#fff" stroke-width="1.6"/>
      <circle cx="17" cy="18" r="2.4" fill="#fff"/><circle cx="31" cy="30" r="2.4" fill="#fff"/>`,

    "managed-identity": () => `
      <path d="M24 7l13 5v9c0 8-5.5 13.5-13 16-7.5-2.5-13-8-13-16v-9z" fill="${AZ}"/>
      <circle cx="21" cy="21" r="4.2" fill="none" stroke="#fff" stroke-width="2.4"/>
      <path d="M23.8 23.8l6 6M27 27l-2 2" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`,

    shield: () => `
      <path d="M24 6l15 5.5v10C39 32 32.5 39 24 42 15.5 39 9 32 9 21.5v-10z" fill="${AZ}"/>
      <path d="M17 24l5 5 9-11" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,

    vnet: () => `
      <circle cx="12" cy="24" r="4.5" fill="${AZ}"/><circle cx="24" cy="24" r="4.5" fill="${AZ}"/><circle cx="36" cy="24" r="4.5" fill="${AZ}"/>
      <path d="M16.5 24h3M28.5 24h3" stroke="${AZ}" stroke-width="2"/>`,

    subnet: () => `
      <circle cx="16" cy="24" r="4.5" fill="${AZ}"/><circle cx="32" cy="24" r="4.5" fill="${AZ}"/>
      <path d="M20.5 24h7" stroke="${AZ}" stroke-width="2"/>`,
  };
  return (F[key] || F.subnet)();
}
