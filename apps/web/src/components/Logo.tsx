/** The CartGuardian mark: a price tag with a punched hole and a check. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M4 9.5 13.5 3H28v26H13.5L4 22.5Z" className="logo-tag" />
      <circle cx="11" cy="16" r="2.2" className="logo-hole" />
      <path d="m16 16.5 3 3 5.5-6.5" className="logo-check" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <LogoMark />
      <span className="logo-word">CartGuardian</span>
    </span>
  );
}
