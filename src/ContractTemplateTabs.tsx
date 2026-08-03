import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import { reportFrontendDiagnostic } from './FrontendDiagnostics';

export type DocumentType = 'ordinary_lease' | 'fixed_term_building_lease' | 'parking' | 'bicycle_parking' | 'warehouse';
type Template = { document_type: DocumentType; display_name: string; requires_plan: boolean; active_revision_id: string | null };
const order: DocumentType[] = ['ordinary_lease', 'fixed_term_building_lease', 'parking', 'bicycle_parking', 'warehouse'];

export function ContractTemplateTabs({ contractId, currentType, onChanged, readOnly = false }: { contractId: string; currentType: DocumentType; onChanged: () => void; readOnly?: boolean }) {
  const [templates, setTemplates] = useState<Template[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { if (!supabase) { const message = 'Supabaseが設定されていないため契約書種別を取得できません。'; setError(message); reportFrontendDiagnostic(message); return; } void supabase.from('contract_document_template').select('document_type, display_name, requires_plan, active_revision_id').then(({ data, error: loadError }) => { if (loadError) { const message = `契約書種別を取得できません: ${loadError.message}`; setError(message); reportFrontendDiagnostic(message, loadError); return; } setTemplates((data ?? []) as Template[]); }); }, []);
  const select = async (next: Template) => {
    if (!supabase || next.document_type === currentType || !next.active_revision_id) return;
    if (!window.confirm(`契約書を「${next.display_name}」へ変更します。現在の入力内容とPDFは履歴へ退避されます。`)) return;
    setBusy(true); setError(''); const { data: document, error: documentError } = await supabase.from('lease_contract_document').select('*').eq('lease_contract_id', contractId).maybeSingle();
    const historyResult = document ? await supabase.from('lease_contract_document_history').insert({ lease_contract_id: contractId, document_type: document.document_type, archived_document: document }) : { error: null };
    const updateResult = !documentError && !historyResult.error ? await supabase.from('lease_contract_document').update({ document_type: next.document_type, contract_document_template_revision_id: next.active_revision_id, field_values: {}, workflow_defaults: {}, manually_edited_fields: [], terms_text: '', restoration_criteria_text: '', pdf_file_path: null, pdf_generated_at: null }).eq('lease_contract_id', contractId) : { error: documentError ?? historyResult.error };
    setBusy(false); if (updateResult.error) { const message = `契約書種別を変更できません: ${updateResult.error.message}`; setError(message); reportFrontendDiagnostic(message, updateResult.error); return; } onChanged();
  };
  return <section className="contract-template-tabs"><div className="contract-document-tabs" role="tablist">{order.map((type) => { const template = templates.find((item) => item.document_type === type); const ready = Boolean(template?.active_revision_id); return <button key={type} type="button" role="tab" aria-selected={currentType === type} className={currentType === type ? 'active' : ''} disabled={busy || readOnly || !ready} onClick={() => template && void select(template)}>{template?.display_name ?? type}{!ready && <small>ひな型準備中</small>}</button>; })}</div>{readOnly && <p className="document-message">デモでは契約種別を変更できません。</p>}{error && <p className="document-message error">{error}</p>}</section>;
}
