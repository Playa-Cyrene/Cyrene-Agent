import type { SimpleIcon } from "simple-icons";

interface BrandIconProps {
  icon: SimpleIcon;
  size?: number;
  label?: string;
}

/** Brand marks come from Simple Icons; keep their supplied path and brand color. */
export function BrandIcon({ icon, size = 20, label }: BrandIconProps) {
  return <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={`#${icon.hex}`}
    role={label ? "img" : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : true}
    focusable="false"
  ><path d={icon.path} /></svg>;
}
