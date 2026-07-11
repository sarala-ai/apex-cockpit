// Shim: our panes were designed against a Badge with semantic status
// variants (`success` / `danger` / `info`) that the fork's shadcn Badge
// (`ui/src/components/ui/badge.tsx`) doesn't have — it only ships
// default/secondary/destructive/outline/ghost/link. Rather than editing the
// shared shadcn primitive, map our semantic names to color classNames on
// top of the fork's `outline` variant.
import type { ComponentProps } from 'react';
import { Badge } from '@/components/ui/badge';

export type StatusVariant = 'default' | 'success' | 'danger' | 'info';

const COLOR_CLASSES: Record<StatusVariant, string> = {
  default: '',
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  danger: 'border-red-500/30 bg-red-500/10 text-red-400',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-400',
};

export function StatusBadge({
  variant = 'default',
  className,
  ...props
}: Omit<ComponentProps<typeof Badge>, 'variant'> & { variant?: StatusVariant }) {
  const badgeVariant = variant === 'default' ? 'default' : 'outline';
  const colorClass = COLOR_CLASSES[variant];
  return (
    <Badge
      variant={badgeVariant}
      className={[colorClass, className].filter(Boolean).join(' ')}
      {...props}
    />
  );
}
