import { cn } from '../lib/utils';
import type { IrisState } from '../hooks/useIrisState';

interface BacklightProps {
  state: IrisState;
  className?: string; // Add className prop
}

export function Backlight({ state, className }: BacklightProps) {
  return (
    <div
      className={cn('backlight', `state-${state}`, className)}
      aria-hidden="true"
    />
  );
}
