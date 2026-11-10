import { useEffect, useRef } from "react";
import type { IsoScene } from "./iso/IsoScene";

/** Mounts the isometric office once (lazy-loaded). The scene syncs itself from the stores. */
export function OfficeCanvas() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let scene: IsoScene | null = null;
    let gone = false;
    void import("./iso/IsoScene").then((m) => {
      if (gone) return;
      scene = new m.IsoScene();
      void scene.init(el);
    });
    return () => {
      gone = true;
      scene?.destroy();
    };
  }, []);

  return <div ref={host} className="fixed inset-0" aria-label="Pixel-art view of the office: every running project's team" role="img" />;
}
