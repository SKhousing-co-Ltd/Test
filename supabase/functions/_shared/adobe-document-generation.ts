export const adobeCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type AdobeJob = {
  status?: string;
  assetID?: string;
  asset?: { assetID?: string };
  output?: { assetID?: string };
  result?: { assetID?: string };
  error?: unknown;
  errors?: unknown;
};

function failureDetail(job: AdobeJob) {
  return JSON.stringify({ status: job.status ?? null, error: job.error ?? null, errors: job.errors ?? null });
}

export async function adobeToken() {
  const clientId = Deno.env.get('ADOBE_PDF_SERVICES_CLIENT_ID');
  const clientSecret = Deno.env.get('ADOBE_PDF_SERVICES_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('Adobe credentials are not configured.');
  const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
  const result = await fetch('https://pdf-services.adobe.io/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
  });
  const payload = await result.json();
  if (!result.ok || !payload.access_token) throw new Error(`Adobe OAuth failed: ${payload.error_description ?? payload.error ?? result.status}`);
  return { token: payload.access_token as string, clientId };
}

async function adobeJson(url: string, token: string, clientId: string, init: RequestInit = {}) {
  const result = await fetch(url, { ...init, headers: { 'x-api-key': clientId, Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const text = await result.text(); let payload: Record<string, unknown> = {};
  if (text) { try { payload = JSON.parse(text) as Record<string, unknown>; } catch { payload = { message: text }; } }
  if (!result.ok) throw new Error(`Adobe API failed: ${String((payload.error as Record<string, unknown> | undefined)?.message ?? payload.message ?? result.status)}`);
  return payload;
}

export async function uploadAdobeAsset(bytes: Uint8Array, mediaType: string, token: string, clientId: string) {
  const asset = await adobeJson('https://pdf-services.adobe.io/assets', token, clientId, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaType }),
  });
  const upload = await fetch(asset.uploadUri as string, { method: 'PUT', headers: { 'Content-Type': mediaType }, body: bytes });
  if (!upload.ok) throw new Error(`Adobe asset upload failed: ${upload.status}`);
  return asset.assetID as string;
}

export async function runAdobeJob(operation: string, body: Record<string, unknown>) {
  const { token, clientId } = await adobeToken();
  const result = await fetch(`https://pdf-services.adobe.io/operation/${operation}`, {
    method: 'POST', headers: { 'x-api-key': clientId, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const startText = await result.text(); let job: AdobeJob = {};
  if (startText) { try { job = JSON.parse(startText) as AdobeJob; } catch { job = { error: { message: startText } }; } }
  if (!result.ok) throw new Error(`Adobe ${operation} failed: ${failureDetail(job)}`);
  const location = result.headers.get('location');
  if (!location) throw new Error(`Adobe ${operation} did not return a job location.`);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const outputAssetId = job.assetID ?? job.asset?.assetID ?? job.output?.assetID ?? job.result?.assetID;
    if (outputAssetId) {
      const asset = await adobeJson(`https://pdf-services.adobe.io/assets/${outputAssetId}`, token, clientId);
      const download = await fetch(asset.downloadUri as string);
      if (!download.ok) throw new Error(`Adobe output download failed: ${download.status}`);
      return new Uint8Array(await download.arrayBuffer());
    }
    if (job.status === 'failed') throw new Error(`Adobe ${operation} job failed: ${failureDetail(job)}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    job = await adobeJson(location, token, clientId) as AdobeJob;
  }
  throw new Error(`Adobe ${operation} timed out.`);
}

export const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
