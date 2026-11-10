// Per-device preferences in localStorage, under "arimaops.<name>". Values saved
// under the older prefixes ("dothq.", "jsmhq.") are still read, so a rename
// doesn't reset anyone's layout or font. Never throws (private windows).

import { BRAND } from "../data/brand";

export const prefKey = (name: string) => `${BRAND.storagePrefix}.${name}`;

export function readPref(name: string): string | null {
  try {
    for (const p of [BRAND.storagePrefix, ...BRAND.legacyStoragePrefixes]) {
      const v = localStorage.getItem(`${p}.${name}`);
      if (v !== null) return v;
    }
  } catch {
    /* private mode */
  }
  return null;
}

export function writePref(name: string, value: string) {
  try {
    localStorage.setItem(prefKey(name), value);
  } catch {
    /* private mode */
  }
}
