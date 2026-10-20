import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import type { StatusTone } from '../../domain/status';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner" role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-soft';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  iconOnly?: boolean;
}

export function buttonClass({
  variant = 'secondary',
  size = 'md',
  block,
  iconOnly,
}: Pick<ButtonProps, 'variant' | 'size' | 'block' | 'iconOnly'>): string {
  return cx('btn', `btn--${variant}`, size !== 'md' && `btn--${size}`, block && 'btn--block', iconOnly && 'btn--icon');
}

export function Button({ variant, size, block, loading, icon, iconOnly, children, disabled, className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(buttonClass({ variant, size, block, iconOnly }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

export function LinkButton({
  variant,
  size,
  block,
  icon,
  children,
  className,
  ...rest
}: LinkProps & Pick<ButtonProps, 'variant' | 'size' | 'block' | 'icon'>) {
  return (
    <Link className={cx(buttonClass({ variant, size, block }), className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}

export function Card({ soft, tight, className, ...rest }: HTMLAttributes<HTMLDivElement> & { soft?: boolean; tight?: boolean }) {
  return <div className={cx('card', soft && 'card--soft', tight && 'card--tight', className)} {...rest} />;
}

export function Badge({ tone = 'neutral', children, icon }: { tone?: StatusTone | 'warning'; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className={cx('badge', tone !== 'neutral' && `badge--${tone}`)}>
      {icon}
      {children}
    </span>
  );
}

type BannerTone = 'info' | 'warning' | 'danger' | 'success';

const BANNER_ICON: Record<BannerTone, ReactNode> = {
  info: <Info aria-hidden />,
  warning: <AlertTriangle aria-hidden />,
  danger: <XCircle aria-hidden />,
  success: <CheckCircle2 aria-hidden />,
};

export function Banner({
  tone = 'info',
  title,
  children,
  actions,
  role,
}: {
  tone?: BannerTone;
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
  role?: 'alert' | 'status';
}) {
  return (
    <div className={`banner banner--${tone}`} role={role ?? (tone === 'danger' ? 'alert' : undefined)}>
      {BANNER_ICON[tone]}
      <div className="grow">
        {title && <div className="banner-title">{title}</div>}
        {children && <div>{children}</div>}
        {actions && <div className="banner-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty card">
      <div className="empty-icon" aria-hidden>
        {icon}
      </div>
      <h2 className="h2">{title}</h2>
      {children && <p className="muted" style={{ maxWidth: 420 }}>{children}</p>}
      {action}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" role="tab" aria-selected={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}
