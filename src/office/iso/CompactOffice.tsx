import { useEffect, useRef } from "react";
import { IsoScene } from "./IsoScene";

/** The isometric office inside the phone/tablet layout: fills its parent, no HUD around it. Lazy-loaded. */
export default function CompactOffice() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const scene = new IsoScene({ compact: true });
    void scene.init(el);
    return () => scene.destroy();
  }, []);

  return <div ref={host} className="absolute inset-0 overflow-hidden" aria-label="Pixel-art view of the office: every running project's team" role="img" />;
}
