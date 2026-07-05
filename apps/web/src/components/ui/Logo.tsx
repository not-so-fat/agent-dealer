import logoPng from "../../assets/logos/agent-dealer.png";

type Props = {
  className?: string;
  /** Header mark — default 36px */
  size?: number;
};

export default function Logo({ className = "", size = 36 }: Props) {
  return (
    <img
      src={logoPng}
      alt=""
      width={size}
      height={size}
      className={`shrink-0 object-contain ${className}`}
      aria-hidden
      draggable={false}
    />
  );
}
