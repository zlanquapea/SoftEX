import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** The width a page's content keeps. `narrow` for reading and forms, `full` for boards and tables. */
export function Page({ children, width = 'default', className }: { children: ReactNode; width?: 'narrow' | 'default' | 'full'; className?: string }) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full flex-col gap-6 px-4 py-6 md:px-8',
        width === 'narrow' && 'max-w-3xl',
        width === 'default' && 'max-w-6xl',
        width === 'full' && 'max-w-none',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A page's title, what it is for, and its main actions. */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  /** Extra lines under the title, such as meta pills. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      {/* At least 16rem wide: on a narrow phone the actions wrap below the title instead of squeezing it. */}
      <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1">
        {eyebrow && <p className="text-xs font-semibold tracking-wide text-primary uppercase">{eyebrow}</p>}
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {description && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A titled block on a page, optionally with actions on the right. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  id,
  'aria-label': ariaLabel,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  'aria-label'?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-3', className)} id={id} aria-label={ariaLabel}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title && <h2 className="font-heading text-base font-semibold">{title}</h2>}
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A card with the full shadcn composition, for the common "title, body, footer" case. */
export function Panel({
  title,
  description,
  action,
  footer,
  children,
  className,
  contentClassName,
  ...props
}: Omit<ComponentProps<typeof Card>, 'title'> & {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
  contentClassName?: string;
}) {
  return (
    <Card className={className} {...props}>
      {(title || description || action) && (
        <CardHeader>
          {title && (
            <CardTitle aria-level={2}>
              {title}
            </CardTitle>
          )}
          {description && <CardDescription>{description}</CardDescription>}
          {action && <CardAction>{action}</CardAction>}
        </CardHeader>
      )}
      <CardContent className={contentClassName}>{children}</CardContent>
      {footer && <CardFooter className="gap-2">{footer}</CardFooter>}
    </Card>
  );
}

/** Wrap anything in a tooltip. */
export function Hint({ label, children, side = 'top' }: { label: ReactNode; children: ReactElement; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

/** A button that is just an icon: always has an accessible name, and shows it as a tooltip. */
export function IconButton({
  label,
  children,
  variant = 'ghost',
  size = 'icon',
  tooltip = true,
  ...props
}: Omit<ComponentProps<typeof Button>, 'size' | 'aria-label'> & { label: string; size?: 'icon' | 'icon-sm' | 'icon-xs' | 'icon-lg'; tooltip?: boolean }) {
  const button = (
    <Button variant={variant} size={size} aria-label={label} {...props}>
      {children}
    </Button>
  );
  return tooltip ? <Hint label={label}>{button}</Hint> : button;
}

/** A number card: the headline figure, what it counts, and an optional change or hint. */
export function StatCard({
  label,
  value,
  hint,
  icon,
  tone,
  action,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Card size="sm" className={cn('gap-2', className)}>
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          {icon}
          {label}
        </CardDescription>
        <CardTitle
          className={cn(
            'font-heading text-3xl font-semibold tabular-nums',
            tone === 'success' && 'text-success',
            tone === 'warning' && 'text-warning',
            tone === 'danger' && 'text-destructive',
          )}
        >
          {value}
        </CardTitle>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      {hint && <CardContent className="text-xs text-muted-foreground">{hint}</CardContent>}
    </Card>
  );
}

/** A responsive row of StatCards. */
export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-2 gap-3 lg:grid-cols-4', className)}>{children}</div>;
}

/** Progress towards 100%, with an optional label and the percentage. */
export function ProgressBar({ value, label, showValue = false, className }: { value: number; label?: ReactNode; showValue?: boolean; className?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {(label || showValue) && (
        <div className="flex items-center justify-between gap-2 text-sm">
          {label && <span className="text-muted-foreground">{label}</span>}
          {showValue && <span className="font-medium tabular-nums">{pct}%</span>}
        </div>
      )}
      <Progress value={pct} aria-label={typeof label === 'string' ? label : 'Progress'} />
    </div>
  );
}

/** Usage against a limit (members, storage…), turning amber near the limit and red over it. */
export function Meter({
  label,
  used,
  limit,
  format = (n) => n.toLocaleString(),
  note,
}: {
  label: ReactNode;
  used: number;
  limit: number | null;
  format?: (n: number) => string;
  /** A line under the bar, e.g. what happens at the limit. */
  note?: ReactNode;
}) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const tone = !limit ? '' : used >= limit ? '[&_[data-slot=progress-indicator]]:bg-destructive' : pct >= 80 ? '[&_[data-slot=progress-indicator]]:bg-warning' : '';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span>{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {format(used)}
          {limit ? ` of ${format(limit)}` : ' · no limit'}
        </span>
      </div>
      {limit ? <Progress value={pct} className={tone} aria-label={typeof label === 'string' ? label : 'Usage'} /> : null}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
