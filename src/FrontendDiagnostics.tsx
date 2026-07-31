import { useEffect, useState } from 'react';

type Diagnostic = { message: string; detail?: string; at: string };
const listeners = new Set<(item: Diagnostic) => void>();

export function reportFrontendDiagnostic(message: string, detail?: unknown) {
  const item = { message, detail: detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : undefined, at: new Date().toLocaleTimeString('ja-JP') };
  listeners.forEach((listener) => listener(item));
}

export function FrontendDiagnostics() {
  const [items, setItems] = useState<Diagnostic[]>([]);
  useEffect(() => {
    const add = (item: Diagnostic) => setItems((current) => [item, ...current].slice(0, 5));
    const onError = (event: ErrorEvent) => reportFrontendDiagnostic('画面処理で予期しないエラーが発生しました。', event.error ?? event.message);
    const onRejection = (event: PromiseRejectionEvent) => reportFrontendDiagnostic('通信または非同期処理が失敗しました。', event.reason);
    listeners.add(add); window.addEventListener('error', onError); window.addEventListener('unhandledrejection', onRejection);
    return () => { listeners.delete(add); window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); };
  }, []);
  if (!items.length) return null;
  return <aside className="frontend-diagnostics" role="alert"><strong>デバッグ情報</strong>{items.map((item, index) => <p key={`${item.at}-${index}`}><time>{item.at}</time>{item.message}{item.detail && <code>{item.detail}</code>}</p>)}<button type="button" onClick={() => setItems([])}>閉じる</button></aside>;
}
