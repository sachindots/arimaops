// The ArimaOps lion: an outline head adapted from Griddy Icons (MIT, LICENSES/THIRD-PARTY.txt). Inline, so it takes
// the project accent (blue for build, red for red team) and follows light and dark without a second file.

export function Lion({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className={`shrink-0 ${className}`}>
      <path d="m8.585 8.58l2 1l-.67 1.34l-2-1zm5.5 2.34l2-1l-.67-1.34l-2 1z"/><path fillRule="evenodd" clipRule="evenodd" d="M6.471 6.148A2.75 2.75 0 0 1 8.94 5.135l3.06.36l3.06-.36a2.750 2.75 0 0 1 2.469 1.013L19 7.987v4.99l-1.532 2.298a2.75 2.75 0 0 1-1.978 1.207A2.75 2.75 0 0 1 12.75 19h-1.5a2.75 2.75 0 0 1-2.74-2.518a2.75 2.75 0 0 1-1.978-1.207L5 12.977v-4.99zM12 15.652a2.75 2.75 0 0 0 1.975.848c-.116.57-.62 1-1.225 1h-1.5a1.250 1.25 0 0 1-1.225-1A2.75 2.75 0 0 0 12 15.652M8.765 6.625a1.25 1.25 0 0 0-1.123.46L6.5 8.513v4.01l1.28 1.92A1.25 1.25 0 0 0 8.820 15h1.194a1.25 1.25 0 0 0 1.118-.691l.118-.236V13.5h-.75V12h3v1.5h-.75v.573l.118.236a1.25 1.25 0 0 0 1.118.691h1.194a1.25 1.25 0 0 0 1.04-.557l1.28-1.92v-4.01l-1.142-1.428a1.25 1.25 0 0 0-1.123-.46L12 7.005z"/><path fillRule="evenodd" clipRule="evenodd" d="M7.037 1.696a2.75 2.75 0 0 0-2.605 1.027l-3.02 3.883l.566 1.699l-1.049 5.767l2.111 1.583l.518 4.66l8.45 2.726l7.883-2.719l1.031-4.638l2.149-1.612l-1.049-5.767l.567-1.699l-3.020-3.883a2.75 2.75 0 0 0-2.606-1.027L12 2.49zM5.616 3.644A1.25 1.25 0 0 1 6.8 3.178l5.2.832l5.2-.832a1.25 1.25 0 0 1 1.184.466l2.528 3.250l-.434 1.301l.951 5.233l-1.85 1.388l-.97 4.362l-6.617 2.281l-7.050-2.274l-.482-4.34l-1.89-1.417l.952-5.233l-.434-1.301z"/>
    </svg>
  );
}
