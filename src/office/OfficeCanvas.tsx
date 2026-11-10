import { useEffect, useRef } from "react";
import { OfficeScene } from "./OfficeScene";

interface Scene {
  init(host: HTMLElement): Promise<void>;
  destroy(): void;
}

/** The isometric office is opt-in (`?office=iso` or localStorage arima.office=iso) while it is being built. */
function wantsIso(): boolean {
  try {
    return new URLSearchParams(location.search).get("office") === "iso" || localStorage.getItem("arima.office") === "iso";
  } catch {
    return false;
  }
}

/** Mounts the PixiJS office once. The scene syncs itself from the stores. */
export function OfficeCanvas() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let scene: Scene | null = null;
    let gone = false;
    const make: Promise<Scene> = wantsIso() ? import("./iso/IsoScene").then((m) => new m.IsoScene()) : Promise.resolve(new OfficeScene());
    void make.then((s) => {
      if (gone) return;
      scene = s;
      void s.init(el);
    });
    return () => {
      gone = true;
      scene?.destroy();
    };
  }, []);

  return <div ref={host} className="fixed inset-0" aria-label="Pixel-art view of the .hq cyberspace operations floor" role="img" />;
}
