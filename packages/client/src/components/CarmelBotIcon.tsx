import type { SVGProps } from "react";

export function CarmelBotIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M12 5V3.5M2 12v4m20-4v4" />
      <circle cx="12" cy="2.5" r="1" fill="currentColor" stroke="none" />
      <rect x="4" y="6" width="16" height="15" rx="6" />
      <rect
        x="6.5"
        y="9"
        width="11"
        height="9"
        rx="3.5"
        fill="currentColor"
        fillOpacity=".12"
        stroke="none"
      />
      <path d="M8.5 12v1.5m7-1.5v1.5M9.5 16a3.5 3.5 0 0 0 5 0" />
    </svg>
  );
}
