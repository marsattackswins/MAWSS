/**
 * MAWS pixel-M mark, kept in sync with components/brand/MawsLogo.tsx in the
 * MAWS app (the vendored journal cannot import across app roots).
 * Fills with currentColor so it follows the sidebar text color.
 */
export function MawsMark({ className }: { className?: string }) {
  const cell = 3;
  const origin = 5.5;
  const px = (col: number, row: number) => ({
    x: origin + col * cell,
    y: origin + row * cell,
  });

  // 7×7 classic pixel M
  const cells: Array<[number, number]> = [
    [0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6],
    [6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [6, 5], [6, 6],
    [1, 1], [2, 2], [3, 3], [4, 2], [5, 1],
  ];

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      className={className}
      shapeRendering="crispEdges"
      aria-label="MAWS"
      role="img"
      fill="currentColor"
    >
      <title>MAWS</title>
      {cells.map(([c, r]) => {
        const p = px(c, r);
        return (
          <rect key={`${c}-${r}`} x={p.x} y={p.y} width={cell} height={cell} />
        );
      })}
    </svg>
  );
}
