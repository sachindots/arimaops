/** Ids of the agents `text` names as @Name or @id (case-insensitive), in team order. */
export function mentioned(team: readonly { id: string; name: string }[], text: string): string[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return team.filter((a) => new RegExp(`(^|\\s)@(${esc(a.name)}|${esc(a.id)})(?![\\w-])`, "i").test(text)).map((a) => a.id);
}
