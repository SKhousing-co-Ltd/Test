import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { supabase } from './lib/supabase';
import './UserFeedbackWidget.css';

const MAX_FILES = 3;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function UserFeedbackWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSaving) setIsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isOpen, isSaving]);

  const chooseFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = '';
    setError('');
    if (files.length + selected.length > MAX_FILES) {
      setError('画像は1回の投稿につき3枚まで添付できます。');
      return;
    }
    const invalid = selected.find((file) => !ACCEPTED_TYPES.includes(file.type) || file.size > MAX_FILE_SIZE);
    if (invalid) {
      setError('画像はJPEG・PNG・WebP形式で、1枚5MB以下にしてください。');
      return;
    }
    setFiles((current) => [...current, ...selected]);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || !body.trim() || isSaving) return;
    setIsSaving(true);
    setError('');
    const { data: userResult, error: userError } = await supabase.auth.getUser();
    if (userError || !userResult.user) {
      setError('ログイン情報を確認できませんでした。再度ログインしてください。');
      setIsSaving(false);
      return;
    }

    const uploadedPaths: string[] = [];
    for (const file of files) {
      const extension = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/png' ? 'png' : 'webp';
      const path = `${userResult.user.id}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase.storage.from('user-feedback-images').upload(path, file, { contentType: file.type, upsert: false });
      if (uploadError) {
        if (uploadedPaths.length) await supabase.storage.from('user-feedback-images').remove(uploadedPaths);
        setError('画像をアップロードできませんでした。形式とサイズを確認して再度お試しください。');
        setIsSaving(false);
        return;
      }
      uploadedPaths.push(path);
    }

    const { error: insertError } = await supabase.from('user_feedback').insert({ body: body.trim(), attachment_paths: uploadedPaths });
    if (insertError) {
      if (uploadedPaths.length) await supabase.storage.from('user-feedback-images').remove(uploadedPaths);
      setError('投稿を保存できませんでした。時間をおいて再度お試しください。');
      setIsSaving(false);
      return;
    }
    setIsSaving(false);
    setIsSubmitted(true);
  };

  const close = () => {
    if (isSaving) return;
    setIsOpen(false);
    setBody('');
    setFiles([]);
    setError('');
    setIsSubmitted(false);
  };

  if (import.meta.env.VITE_USER_FEEDBACK_ENABLED === 'false') return null;

  return <>
    <button type="button" className="feedback-fab" onClick={() => setIsOpen(true)} aria-label="意見を送る">意見を送る</button>
    {isOpen && <div className="feedback-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
        <header className="feedback-dialog-header"><div><p>USER FEEDBACK</p><h2 id="feedback-title">ご意見をお聞かせください</h2></div><button type="button" aria-label="閉じる" onClick={close} disabled={isSaving}>×</button></header>
        {isSubmitted ? <div className="feedback-success"><span aria-hidden="true">✓</span><h3>投稿を受け付けました</h3><p>ご意見ありがとうございます。</p><button type="button" className="feedback-submit" onClick={close}>閉じる</button></div> : <form onSubmit={(event) => void submit(event)}>
          <label className="feedback-body-label" htmlFor="feedback-body">ご意見</label>
          <textarea id="feedback-body" value={body} onChange={(event) => setBody(event.target.value)} rows={7} placeholder="気づいたことや改善案をご記入ください" required autoFocus />
          <div className="feedback-attachment-row"><div><strong>スクリーンショット</strong><small>任意・最大3枚・各5MBまで（JPEG / PNG / WebP）</small></div><label className="feedback-file-button">画像を選択<input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={chooseFiles} disabled={files.length >= MAX_FILES} /></label></div>
          {files.length > 0 && <ul className="feedback-file-list">{files.map((file, index) => <li key={`${file.name}-${index}`}><span>{file.name}</span><button type="button" onClick={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))} aria-label={`${file.name}を削除`}>削除</button></li>)}</ul>}
          {error && <p className="feedback-error" role="alert">{error}</p>}
          <footer><button type="button" className="feedback-cancel" onClick={close} disabled={isSaving}>キャンセル</button><button type="submit" className="feedback-submit" disabled={isSaving || !body.trim()}>{isSaving ? '送信中…' : '投稿する'}</button></footer>
        </form>}
      </section>
    </div>}
  </>;
}
