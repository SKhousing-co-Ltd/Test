import { useEffect, type ReactNode } from 'react';

type DialogProps = { title: string; children: ReactNode; onClose: () => void };

export function Dialog({ title, children, onClose }: DialogProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
      <header><h2>{title}</h2><button type="button" onClick={onClose} aria-label="閉じる">×</button></header>
      {children}
    </section>
  </div>;
}
