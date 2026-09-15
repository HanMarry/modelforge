import { ModelForgeMark } from './icons/ModelForge';
import { cn } from '../utils';

interface ModelForgeLogoProps {
  className?: string;
  size?: 'default' | 'small';
  animate?: boolean;
}

/**
 * Brand mark for the assistant avatar. `animate` adds a slow pulse behind the
 * mark and is used while a session is idle or loading.
 */
export default function ModelForgeLogo({
  className = '',
  size = 'default',
  animate = false,
}: ModelForgeLogoProps) {
  const sizes = {
    default: { frame: 'w-16 h-16', mark: 'w-16 h-16', halo: 'w-14 h-14' },
    small: { frame: 'w-8 h-8', mark: 'w-8 h-8', halo: 'w-7 h-7' },
  } as const;

  const currentSize = sizes[size];

  return (
    <div className={cn(className, currentSize.frame, 'relative')}>
      {animate && (
        <span
          className={cn(currentSize.halo, 'absolute left-0 bottom-0 rounded-full animate-pulse')}
          style={{ backgroundColor: 'rgba(232, 122, 62, 0.15)' }}
        />
      )}
      <ModelForgeMark className={cn(currentSize.mark, 'relative')} />
    </div>
  );
}
