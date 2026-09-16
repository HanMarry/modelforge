// GENERATED FILE — do not edit by hand. Source: src/brand-mark.json
import { cn } from '../../utils';

const PRIMARY = '#303941';
const FRONT = '#333c44';
const ACCENT = '#e57d4a';
const SECONDARY = '#565f66';

/**
 * The ModelForge mark: an isometric cube of four faces, traced from the brand
 * artwork. Each polygon was fitted to the source mask and checked to IoU > 0.95
 * by scripts/build-brand-mark.js; the raster icons are rendered from the same
 * artwork by scripts/build-brand-icons.js.
 */
export function ModelForgeMark({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M12.632 11.939 L12.172 11.939 L0.344 3.533 L0.115 3.289 L0.115 2.924 L4.019 0.365 L4.938 0 L12.861 5.239 L13.091 5.239 L19.177 1.096 L23.885 3.777 L23.885 4.142 Z"
        fill={PRIMARY}
      />
      <path
        d="M11.598 14.863 L12.057 14.254 L14.928 12.426 L15.617 12.183 L15.617 21.32 L12.402 23.513 L11.713 23.756 Z"
        fill={FRONT}
      />
      <path
        d="M17.225 10.964 L22.392 7.553 L22.507 14.619 L17.569 18.03 L17.34 18.03 Z"
        fill={ACCENT}
      />
      <path
        d="M4.823 20.832 L0.115 17.421 L0 17.178 L0.115 5.482 L0.459 5.482 L5.856 9.503 L5.742 21.32 Z"
        fill={SECONDARY}
      />
    </svg>
  );
}

export function ModelForgeWordmark({ className = '' }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <ModelForgeMark className="h-[1.15em] w-[1.15em]" />
      <span>
        Model<span style={{ color: ACCENT }}>Forge</span>
      </span>
    </span>
  );
}
