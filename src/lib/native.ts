import { ui, useUi } from "../store/ui";

declare global {
  interface Window {
    ArimaNative?: { platform(): "android"; switchServer(): void };
    __arimaBack?: () => boolean;
  }
}

export function closeTopPanel(): boolean {
  const { setupOpen, settings, drawer } = useUi.getState();
  if (setupOpen) ui.closeSetup();
  else if (settings) ui.closeSettings();
  else if (drawer) ui.closeDrawer();
  else return false;
  return true;
}
