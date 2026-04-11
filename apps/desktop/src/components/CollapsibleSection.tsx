import { memo, type ReactNode } from 'react';

export type CollapsibleSectionProps = {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
  count?: number;
};

function CollapsibleSection({
  label,
  open,
  onToggle,
  children,
  className,
  count,
}: CollapsibleSectionProps) {
  return (
    <section className={`collapse-section ${className ?? ''}`.trim()}>
      <button
        type="button"
        className="collapse-trigger"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span>{label}</span>
        <span className="collapse-meta">
          {typeof count === 'number' ? <span>{count}</span> : null}
          <span aria-hidden="true" className={`collapse-icon ${open ? 'is-open' : ''}`.trim()}>
            ›
          </span>
        </span>
      </button>
      {open ? (
        <div className="collapse-content">
          <div className="collapse-inner">{children}</div>
        </div>
      ) : null}
    </section>
  );
}

export default memo(CollapsibleSection);
