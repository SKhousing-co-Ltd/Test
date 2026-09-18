/**
 * 案件進捗管理 Google Sheet -> Supabase staging 同期。
 * 既存の APP_CONFIG と REQUIRED_ISSUE_HEADERS を利用する。
 */

const CASE_PROGRESS_SOURCE_SYSTEM = 'google_sheets';
const CASE_PROGRESS_TIME_ZONE = 'Asia/Tokyo';
const CASE_PROGRESS_TRIGGER_FUNCTION = 'syncCaseProgress';

function verifyCaseProgressSheetAccess() {
  const source = readCaseProgressSource_();
  const idColumnIndex = source.headers.indexOf('ID');
  const nonEmptyRows = source.displayRows.filter(row => row.some(value => value.trim() !== ''));
  const ids = nonEmptyRows.map(row => row[idColumnIndex].trim()).filter(id => id !== '');
  const idCounts = ids.reduce((counts, id) => {
    counts[id] = (counts[id] || 0) + 1;
    return counts;
  }, {});
  const duplicateIds = Object.entries(idCounts)
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ id, count }));
  const missingHeaders = REQUIRED_ISSUE_HEADERS.filter(header => !source.headers.includes(header));
  const duplicateHeaders = [...new Set(source.headers.filter((header, index) => header && source.headers.indexOf(header) !== index))];
  const result = {
    spreadsheetId: source.spreadsheet.getId(),
    spreadsheetName: source.spreadsheet.getName(),
    spreadsheetTimeZone: source.timeZone,
    sheetName: source.sheet.getName(),
    lastRow: source.sheet.getLastRow(),
    lastColumn: source.sheet.getLastColumn(),
    dataRowCount: nonEmptyRows.length,
    blankIdCount: nonEmptyRows.length - ids.length,
    headers: source.headers,
    missingHeaders,
    duplicateHeaders,
    idCount: ids.length,
    duplicateIdCount: duplicateIds.length,
    duplicateIds,
  };
  console.log(JSON.stringify(result, null, 2));
  if (missingHeaders.length) throw new Error(`必須ヘッダーが不足しています: ${missingHeaders.join(', ')}`);
  if (duplicateHeaders.length) throw new Error(`ヘッダーが重複しています: ${duplicateHeaders.join(', ')}`);
  if (duplicateIds.length) throw new Error(`IDが重複しています: ${duplicateIds.map(item => `${item.id}(${item.count}件)`).join(', ')}`);
  return result;
}

function syncCaseProgress(event) {
  const triggerType = event && event.triggerUid ? 'scheduled' : 'manual';
  let source = null;
  try {
    source = readCaseProgressSource_();
    const payload = buildCaseProgressPayload_(source, triggerType);
    const result = postCaseProgressPayload_(payload);
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    if (source) {
      try {
        postCaseProgressPayload_({
          sourceSystem: CASE_PROGRESS_SOURCE_SYSTEM,
          spreadsheetId: APP_CONFIG.SPREADSHEET_ID,
          sheetName: APP_CONFIG.ISSUE_SHEET_NAME,
          spreadsheetTimeZone: source.timeZone,
          triggerType,
          clientError: {
            code: 'APPS_SCRIPT_VALIDATION_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
          headers: source.headers,
        });
      } catch (reportError) {
        console.error(`失敗履歴をSupabaseへ送信できませんでした: ${String(reportError)}`);
      }
    }
    throw error;
  }
}

function setupDailyTrigger() {
  if (SpreadsheetApp.openById(APP_CONFIG.SPREADSHEET_ID).getSpreadsheetTimeZone() !== CASE_PROGRESS_TIME_ZONE) {
    throw new Error(`Spreadsheetのタイムゾーンを${CASE_PROGRESS_TIME_ZONE}に設定してください。`);
  }
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === CASE_PROGRESS_TRIGGER_FUNCTION)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  const trigger = ScriptApp.newTrigger(CASE_PROGRESS_TRIGGER_FUNCTION)
    .timeBased()
    .atHour(4)
    .everyDays(1)
    .inTimezone(CASE_PROGRESS_TIME_ZONE)
    .create();
  console.log(`日次同期トリガーを作成しました: ${trigger.getUniqueId()}`);
}

function readCaseProgressSource_() {
  const spreadsheet = SpreadsheetApp.openById(APP_CONFIG.SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(APP_CONFIG.ISSUE_SHEET_NAME);
  if (!sheet) throw new Error(`対象シートが見つかりません: ${APP_CONFIG.ISSUE_SHEET_NAME}`);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 1 || lastColumn < 1) throw new Error('案件シートにデータがありません。');
  const range = sheet.getRange(1, 1, lastRow, lastColumn);
  const displayGrid = range.getDisplayValues();
  const typedGrid = range.getValues();
  return {
    spreadsheet,
    sheet,
    timeZone: spreadsheet.getSpreadsheetTimeZone(),
    headers: displayGrid[0].map(value => value.trim()),
    displayRows: displayGrid.slice(1),
    typedRows: typedGrid.slice(1),
  };
}

function buildCaseProgressPayload_(source, triggerType) {
  if (source.timeZone !== CASE_PROGRESS_TIME_ZONE) {
    throw new Error(`Spreadsheetのタイムゾーンが${CASE_PROGRESS_TIME_ZONE}ではありません。`);
  }
  const missingHeaders = REQUIRED_ISSUE_HEADERS.filter(header => !source.headers.includes(header));
  const duplicateHeaders = [...new Set(source.headers.filter((header, index) => header && source.headers.indexOf(header) !== index))];
  if (missingHeaders.length) throw new Error(`必須ヘッダーが不足しています: ${missingHeaders.join(', ')}`);
  if (duplicateHeaders.length) throw new Error(`ヘッダーが重複しています: ${duplicateHeaders.join(', ')}`);

  const rows = [];
  source.displayRows.forEach((displayRow, rowIndex) => {
    if (!displayRow.some(value => value.trim() !== '')) return;
    const typedRow = source.typedRows[rowIndex];
    const displayValues = {};
    const typedValues = {};
    source.headers.forEach((header, columnIndex) => {
      if (!header) return;
      displayValues[header] = displayRow[columnIndex];
      const value = typedRow[columnIndex];
      typedValues[header] = value instanceof Date
        ? Utilities.formatDate(value, CASE_PROGRESS_TIME_ZONE, 'yyyy-MM-dd')
        : value;
    });
    rows.push({ sourceRowNumber: rowIndex + 2, displayValues, typedValues });
  });
  if (!rows.length) throw new Error('同期対象のデータ行がありません。');

  return {
    sourceSystem: CASE_PROGRESS_SOURCE_SYSTEM,
    spreadsheetId: APP_CONFIG.SPREADSHEET_ID,
    sheetName: APP_CONFIG.ISSUE_SHEET_NAME,
    spreadsheetTimeZone: source.timeZone,
    triggerType,
    clientError: null,
    headers: source.headers,
    rows,
  };
}

function postCaseProgressPayload_(payload) {
  const properties = PropertiesService.getScriptProperties();
  const syncUrl = properties.getProperty('CASE_PROGRESS_SYNC_URL');
  const syncSecret = properties.getProperty('CASE_PROGRESS_SYNC_SECRET');
  if (!syncUrl || !syncSecret) throw new Error('CASE_PROGRESS_SYNC_URLまたはCASE_PROGRESS_SYNC_SECRETが未設定です。');
  const response = UrlFetchApp.fetch(syncUrl, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { 'x-case-progress-sync-secret': syncSecret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  const body = response.getContentText();
  let result;
  try {
    result = JSON.parse(body);
  } catch (_error) {
    throw new Error(`同期APIがJSON以外を返しました (HTTP ${status})`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(result.error || `案件進捗同期に失敗しました (HTTP ${status})`);
  }
  return result;
}
