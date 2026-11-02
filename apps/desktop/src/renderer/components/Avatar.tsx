import { colorForName, initial } from '../lib/format';

interface AvatarProps {
  name: string;
  size?: number;
  fontSize?: number;
}

export function Avatar({ name, size = 28, fontSize }: AvatarProps) {
  return (
    <div
      className="avatar"
      style={{
        width: size,
        height: size,
        background: colorForName(name),
        fontSize: fontSize ?? Math.round(size * 0.42),
      }}
      aria-hidden
    >
      {initial(name)}
    </div>
  );
}
