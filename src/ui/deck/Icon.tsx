/** A Material Symbols icon by its ligature name ("inbox", "dashboard"). Decorative: give the button its own label. */
export function Icon({ name, size = 20, className = "" }: { name: string; size?: number; className?: string }) {
  return (
    <span className={`icon ${className}`} style={{ fontSize: size }} aria-hidden="true">
      {name}
    </span>
  );
}
