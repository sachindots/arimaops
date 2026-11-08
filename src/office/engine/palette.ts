// Office palette — Black-Red + Hacker Terminal Cyberspace bunker theme.

import { colors } from "../../theme/tokens";

export const C = {
  ink: "#040508",
  grass: "#050609", grassD: "#080b12", grassL: "#0e1422",
  path: "#101521", pathD: "#ff1744",
  wood: "#0b0e17", woodD: "#070910", woodL: "#161d2e", woodLine: "#141b2b",
  wall: "#101522", wallD: "#0a0e17", wallL: "#1b2438", wallTop: "#06080d", wallTopL: "#ff1744", base: "#260d17",
  wallSrv: "#0c121e", wallSrvD: "#080c14",
  carpetJ: "#290915", carpetJD: "#470e23",
  rugG: "#082216", rugGD: "#05150e", rugP: "#1c0d2b", rugPD: "#12081c",
  tileL: "#0e131f", tileD: "#0a0d16",
  grate: "#090c14", grateD: "#05070c", grateL: "#141b2b",
  part: "#171f30", partD: "#0e131f", partCap: "#2b3856",
  desk: "#141a29", deskD: "#0d111c", deskDD: "#070910",
  metal: "#2b354d", metalL: "#435275", metalD: "#1b2233", metalDD: "#0f141f",
  screen: "#030a06", bezel: "#1e273b",
  leaf: "#00c853", leafD: "#007a33", leafL: "#00ff66", pot: "#1c2233", potD: "#111520",
  belt: "#0d111a", beltL: "#ff1744", rail: "#2b364f",
  cork: "#080b12", corkD: "#2b121c",
  sky: "#070c18", skyN: "#04060c", cloud: "#ff1744",
  couch: "#1e1230", couchD: "#130b20",
  red: colors.red, orange: colors.orange, yellow: colors.yellow, green: colors.green, blue: colors.blue, lav: colors.lav,
  pink: colors.pink, peach: "#ff2a85", white: colors.white, navy: colors.navy,
  rabbit: "#ff1744", gold: "#00ff66",
  shadow: "#020305",
} as const;

/** Floor carpet colours for desks, cycled by desk index (crimson, phosphor, cyan, violet, magenta, cobalt). */
export const deskCarpets: [string, string][] = [
  ["#240b15", "#381020"],
  ["#082115", "#0d3320"],
  ["#091d29", "#0e2d40"],
  ["#1b0e2b", "#2a1542"],
  ["#260c1f", "#3b1230"],
  ["#0d162e", "#152347"],
];
