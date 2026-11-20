import './RouteLoadingFallback.css';

export function RouteLoadingFallback() {
  return <div className="route-loading" role="status" aria-live="polite"><span className="loading-mark" aria-hidden="true" /><span>画面を読み込んでいます…</span></div>;
}
