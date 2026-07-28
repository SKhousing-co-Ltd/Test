import { createWorker } from 'tesseract.js';
import jpnData from '@tesseract.js-data/jpn';

const imagePath = process.argv[2];
if (!imagePath) throw new Error('画像パスが必要です。');
const worker = await createWorker('jpn', 1, { langPath: jpnData.langPath, gzip: jpnData.gzip });
try {
  const result = await worker.recognize(imagePath);
  process.stdout.write(JSON.stringify({ text: result.data.text }));
} finally {
  await worker.terminate();
}
