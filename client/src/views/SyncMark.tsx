/** BenSync's sync-arrows mark, in one colour: the AI Assistant's icon. */
export default function SyncMark({ size = 16, color = "currentColor" }: { size?: number; color?: string }) {
  const arc = (
    <>
      <path d="M19.93 39.06 A32 32 0 0 1 79.23 36.99" fill="none" stroke={color} strokeWidth="13" />
      <path d="M-3 -12 L15 0 L-3 12 Z" fill={color} transform="translate(80.07 39.06) rotate(70)" />
    </>
  );
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <g>{arc}</g>
      <g transform="rotate(180 50 50)">{arc}</g>
    </svg>
  );
}
