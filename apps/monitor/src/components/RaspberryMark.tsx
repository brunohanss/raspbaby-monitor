export function RaspberryMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 82"
      fill="none"
      aria-hidden="true"
    >
      <g stroke="#070910" strokeWidth="2.6" strokeLinejoin="round">
        <path
          d="M31 22C18 23 8 13 10 4c13-1 23 4 23 15C36 7 47 2 58 5c0 10-11 20-26 18"
          fill="#68c848"
        />
        <path
          d="M12 6c6 3 13 7 20 14M56 7c-8 3-14 7-22 14"
          stroke="#358b32"
          strokeWidth="1.5"
        />
        <path
          d="M32 22C12 20 3 34 7 50c1 14 11 26 25 29 15-3 25-15 26-29 4-16-6-30-26-28Z"
          fill="#d71358"
        />
        <ellipse
          cx="21"
          cy="31"
          rx="8.2"
          ry="8.5"
          fill="#f42473"
          transform="rotate(-20 21 31)"
        />
        <ellipse
          cx="42"
          cy="31"
          rx="8.2"
          ry="8.5"
          fill="#ee236c"
          transform="rotate(20 42 31)"
        />
        <ellipse
          cx="12"
          cy="44"
          rx="6.5"
          ry="10"
          fill="#e61962"
          transform="rotate(12 12 44)"
        />
        <ellipse cx="32" cy="44" rx="10" ry="11" fill="#f02672" />
        <ellipse
          cx="52"
          cy="44"
          rx="6.5"
          ry="10"
          fill="#e61962"
          transform="rotate(-12 52 44)"
        />
        <ellipse
          cx="19"
          cy="61"
          rx="8"
          ry="10"
          fill="#eb2069"
          transform="rotate(-25 19 61)"
        />
        <ellipse
          cx="44"
          cy="61"
          rx="8"
          ry="10"
          fill="#e91b64"
          transform="rotate(25 44 61)"
        />
        <ellipse cx="32" cy="72" rx="9" ry="6.6" fill="#e82066" />
      </g>
    </svg>
  );
}
