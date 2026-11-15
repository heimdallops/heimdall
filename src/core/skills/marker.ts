/** Stamped into every installed file so a reinstall can tell its own output from a hand edit. */
const MARKER = 'heimdall-generated:';

export const markerText = (version: string): string =>
  `${MARKER} v${version} — installed by \`heimdall skills install\`. Edits are overwritten.`;

export const hasGeneratedMarker = (contents: string): boolean => contents.includes(MARKER);

export const markerVersion = (contents: string): string | undefined =>
  new RegExp(`${MARKER}\\s*v([0-9][^\\s]*)`).exec(contents)?.[1];
