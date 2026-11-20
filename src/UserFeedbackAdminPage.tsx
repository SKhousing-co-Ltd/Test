import { useCallback, useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import './UserFeedbackAdminPage.css';

const PAGE_SIZE = 50;
type Feedback = { id: string; user_id: string | null; body: string; attachment_paths: string[]; created_at: string };
type FeedbackAuthor = { user_id: string; email: string };

export function UserFeedbackAdminPage() {
  const [rows, setRows] = useState<Feedback[]>([]);
  const [authors, setAuthors] = useState<Record<string, string>>({});
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (nextPage = page) => {
    if (!supabase) return;
    setIsLoading(true);
    setError('');
    const start = nextPage * PAGE_SIZE;
    const { data, count, error: queryError } = await supabase.from('user_feedback').select('id,user_id,body,attachment_paths,created_at', { count: 'exact' }).order('created_at', { ascending: false }).range(start, start + PAGE_SIZE - 1);
    if (queryError) {
      setError('意見一覧を読み込めませんでした。');
      setIsLoading(false);
      return;
    }
    const feedback = (data ?? []) as Feedback[];
    setRows(feedback);
    setTotal(count ?? 0);
    setPage(nextPage);

    const userIds = [...new Set(feedback.flatMap((row) => row.user_id ? [row.user_id] : []))];
    if (userIds.length) {
      const { data: profileRows } = await supabase.from('user_profiles').select('user_id,email').in('user_id', userIds);
      const authorMap: Record<string, string> = {};
      ((profileRows ?? []) as FeedbackAuthor[]).forEach((profile) => { authorMap[profile.user_id] = profile.email; });
      setAuthors((current) => ({ ...current, ...authorMap }));
    }

    const paths = [...new Set(feedback.flatMap((row) => row.attachment_paths ?? []))];
    if (paths.length) {
      const { data: signed, error: signedError } = await supabase.storage.from('user-feedback-images').createSignedUrls(paths, 3600);
      if (!signedError) {
        const urlMap: Record<string, string> = {};
        (signed ?? []).forEach((item) => { if (item.path && item.signedUrl) urlMap[item.path] = item.signedUrl; });
        setImageUrls((current) => ({ ...current, ...urlMap }));
      }
    }
    setIsLoading(false);
  }, [page]);

  useEffect(() => { void load(0); }, []);

  const deleteFeedback = async (feedback: Feedback) => {
    if (!supabase || !window.confirm('この意見と添付画像を完全に削除します。削除後は元に戻せません。よろしいですか？')) return;
    setDeletingId(feedback.id);
    setError('');
    const paths = feedback.attachment_paths ?? [];
    if (paths.length) {
      const { error: storageError } = await supabase.storage.from('user-feedback-images').remove(paths);
      if (storageError) {
        setError('添付画像を削除できなかったため、投稿は残しました。再度お試しください。');
        setDeletingId('');
        return;
      }
    }
    const { error: deleteError } = await supabase.from('user_feedback').delete().eq('id', feedback.id);
    if (deleteError) {
      setError('画像は削除されましたが、投稿データを削除できませんでした。再度お試しください。');
      setDeletingId('');
      await load(page);
      return;
    }
    setDeletingId('');
    await load(rows.length === 1 && page > 0 ? page - 1 : page);
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return <section className="user-feedback-admin">
    <header className="user-feedback-admin-heading"><div><p className="section-kicker">USER FEEDBACK</p><h1>利用者の意見</h1><p>投稿内容と添付画像を確認し、確認後に削除できます。</p></div><span>{total.toLocaleString('ja-JP')} 件</span></header>
    {error && <p className="user-feedback-admin-error" role="alert">{error}</p>}
    {isLoading ? <div className="user-feedback-admin-empty">読み込み中…</div> : rows.length === 0 ? <div className="user-feedback-admin-empty">投稿はありません。</div> : <>
      <div className="user-feedback-admin-list">{rows.map((feedback) => <article className="user-feedback-admin-card" key={feedback.id}>
        <header><div><strong>{feedback.user_id ? authors[feedback.user_id] ?? 'アカウント情報を確認できません' : '退会済みアカウント'}</strong><time dateTime={feedback.created_at}>{new Date(feedback.created_at).toLocaleString('ja-JP')}</time></div><button type="button" className="user-feedback-delete" onClick={() => void deleteFeedback(feedback)} disabled={Boolean(deletingId)}>{deletingId === feedback.id ? '削除中…' : '削除'}</button></header>
        <p className="user-feedback-admin-body">{feedback.body}</p>
        {feedback.attachment_paths.length > 0 && <div className="user-feedback-admin-images">{feedback.attachment_paths.map((path) => imageUrls[path] ? <a href={imageUrls[path]} target="_blank" rel="noreferrer" key={path}><img src={imageUrls[path]} alt="投稿に添付されたスクリーンショット" /></a> : <span key={path}>画像を読み込めません</span>)}</div>}
      </article>)}</div>
      <nav className="user-feedback-pagination" aria-label="意見一覧ページ"><button type="button" onClick={() => void load(page - 1)} disabled={page === 0}>前へ</button><span>{page + 1} / {pageCount}</span><button type="button" onClick={() => void load(page + 1)} disabled={page + 1 >= pageCount}>次へ</button></nav>
    </>}
  </section>;
}
