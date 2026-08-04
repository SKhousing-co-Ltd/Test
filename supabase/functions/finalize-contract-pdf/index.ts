import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { adobeCorsHeaders, DOCX_MEDIA_TYPE, runAdobeJob, uploadAdobeAsset, adobeToken } from '../_shared/adobe-document-generation.ts';

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...adobeCorsHeaders, 'Content-Type': 'application/json' } });

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: adobeCorsHeaders });
  if (request.method !== 'POST') return respond({ error: 'Method not allowed' }, 405);
  let stage = 'authenticate user';
  let failureContext: { outputRevisionId: string; wordFilePath: string } | null = null;
  let adminForFailure: ReturnType<typeof createClient> | null = null;
  try {
    const url = Deno.env.get('SUPABASE_URL')!; const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!; const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const { leaseContractId } = await request.json();
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: request.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return respond({ error: 'Unauthorized' }, 401);
    if (!leaseContractId) return respond({ error: 'leaseContractId is required.' }, 400);
    const admin = createClient(url, serviceKey); adminForFailure = admin;

    stage = 'load current content version';
    const { data: document, error: documentError } = await userClient.from('lease_contract_document')
      .select('lease_contract_document_id, document_type, content_version, contract_document_template_revision_id')
      .eq('lease_contract_id', leaseContractId).single();
    if (documentError || !document?.contract_document_template_revision_id) return respond({ error: 'No saved contract document or template revision was found.' }, 400);
    const { data: output, error: outputError } = await userClient.from('lease_contract_document_output_revision')
      .select('lease_contract_document_output_revision_id, word_file_path, pdf_file_path, status')
      .eq('lease_contract_document_id', document.lease_contract_document_id).eq('content_version', document.content_version).maybeSingle();
    if (outputError || !output?.word_file_path) return respond({ error: 'Generate the latest Word document before creating the formal PDF.' }, 400);
    if (output.status === 'formalized' && output.pdf_file_path) return respond({ outputRevisionId: output.lease_contract_document_output_revision_id, pdfFilePath: output.pdf_file_path, contentVersion: document.content_version, reused: true });
    failureContext = { outputRevisionId: output.lease_contract_document_output_revision_id, wordFilePath: output.word_file_path };

    stage = 'download generated Word document';
    const { data: word, error: wordError } = await admin.storage.from('contract-documents').download(output.word_file_path);
    if (wordError || !word) throw new Error(`Word output download failed: ${wordError?.message ?? 'not found'}`);

    stage = 'convert Word to PDF';
    const { token, clientId } = await adobeToken();
    const assetID = await uploadAdobeAsset(new Uint8Array(await word.arrayBuffer()), DOCX_MEDIA_TYPE, token, clientId);
    const pdf = await runAdobeJob('createpdf', { assetID });

    stage = 'save formal PDF';
    const pdfFilePath = `documents/${leaseContractId}/${document.document_type}/${document.lease_contract_document_id}/outputs/v${document.content_version}/formal.pdf`;
    const { error: uploadError } = await admin.storage.from('contract-documents').upload(pdfFilePath, pdf, { contentType: 'application/pdf', upsert: false });
    if (uploadError && !/already exists/i.test(uploadError.message)) throw uploadError;
    const formalizedAt = new Date().toISOString();
    const { error: updateOutputError } = await admin.from('lease_contract_document_output_revision').update({ status: 'formalized', pdf_file_path: pdfFilePath, formalized_at: formalizedAt, error_summary: null }).eq('lease_contract_document_output_revision_id', output.lease_contract_document_output_revision_id);
    if (updateOutputError) throw new Error(`Formal PDF history update failed: ${updateOutputError.message}`);
    await admin.from('lease_contract_document').update({ pdf_file_path: pdfFilePath, pdf_generated_at: formalizedAt, latest_formal_output_revision_id: output.lease_contract_document_output_revision_id }).eq('lease_contract_document_id', document.lease_contract_document_id);
    return respond({ outputRevisionId: output.lease_contract_document_output_revision_id, pdfFilePath, contentVersion: document.content_version, reused: false });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (failureContext && adminForFailure) {
      await adminForFailure.from('lease_contract_document_output_revision').update({
        status: 'failed', word_file_path: failureContext.wordFilePath, error_summary: `${stage}: ${detail}`.slice(0, 4000),
      }).eq('lease_contract_document_output_revision_id', failureContext.outputRevisionId);
    }
    console.error(JSON.stringify({ event: 'finalize-contract-pdf-failed', stage, detail }));
    return respond({ error: `Formal PDF generation failed at ${stage}: ${detail}` }, 500);
  }
});
