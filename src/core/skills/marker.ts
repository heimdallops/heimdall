/**
 * Every installed file carries this marker so a reinstall can tell its own output from a
 * file the user wrote or edited. Files without it are never overwritten unless forced.
 */
const MARKER = 'heimdall-generated:';

export const markerText = (version: string): string =>
  `${MARKER} v${version} — installed by \`heimdall skills install\`. Edits are overwritten.`;

export const hasGeneratedMarker = (contents: string): boolean => contents.includes(MARKER);

/**
 * The CLI version recorded in a file's marker, when it has one. Written by every install
 * since the marker existed; read back so `skills list` can report what wrote a skill.
 */
export const markerVersion = (contents: string): string | undefined =>
  new RegExp(`${MARKER}\\s*v([0-9][^\\s]*)`).exec(contents)?.[1];
