/**
 * Every installed file carries this marker so a reinstall can tell its own output from a
 * file the user wrote or edited. Files without it are never overwritten unless forced.
 */
const MARKER = 'heimdall-generated:';

export const markerText = (version: string): string =>
  `${MARKER} v${version} — installed by \`heimdall skills install\`. Edits are overwritten.`;

export const hasGeneratedMarker = (contents: string): boolean => contents.includes(MARKER);
