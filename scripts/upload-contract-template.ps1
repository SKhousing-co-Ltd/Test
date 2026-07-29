param(
  [string]$TemplatePath = 'C:\Users\本庄幸人\OneDrive - SKハウジング株式会社\ＳＫハウジング株式会社 - General\PM共通\2026 DX\契約書ひな型\貸室賃貸借契約書（2025.6.2改訂）.pdf'
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $TemplatePath)) { throw "ひな型PDFが見つかりません: $TemplatePath" }

$settings = @{}
Get-Content .env.local | ForEach-Object {
  if ($_ -match '^\s*([^#=]+?)\s*=\s*(.*)\s*$') { $settings[$Matches[1].Trim()] = $Matches[2].Trim().Trim('"') }
}
if (-not $settings['SUPABASE_ACCESS_TOKEN']) { throw '.env.local に SUPABASE_ACCESS_TOKEN を設定してください。' }
$env:SUPABASE_ACCESS_TOKEN = $settings['SUPABASE_ACCESS_TOKEN']

$templateTemp = 'tmp-contract-template.pdf'
try {
  Copy-Item -LiteralPath $TemplatePath -Destination $templateTemp -Force
  npx.cmd supabase@latest --experimental storage cp $templateTemp 'ss:///contract-documents/templates/ordinary_lease/loan-room-lease-2025-06-02-source-refresh-2026-07-29.pdf' --linked --content-type application/pdf
} finally {
  if (Test-Path -LiteralPath $templateTemp) { Remove-Item -LiteralPath $templateTemp -Force }
}
