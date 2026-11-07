// Generate an offline report from the bundled synthetic example only.
import {writeFile} from 'node:fs/promises';
import {createDemoInput} from './demo-isolated-input.mjs';
import {renderIsolatedReport} from './src/isolated-report.mjs';

const args = process.argv.slice(2);
if (args.length !== 1 || !args[0] || args[0] === '--help' || args[0] === '-h') {
  console.error('Usage: node tools/review-preview/isolated-report-demo.mjs OUTPUT.html (new file)');
  process.exitCode = args.length === 1 && ['-h', '--help'].includes(args[0]) ? 0 : 2;
} else {
  try {
    const html = renderIsolatedReport(createDemoInput(), {synthetic: true});
    await writeFile(args[0], html, {encoding: 'utf8', flag: 'wx', mode: 0o600});
    console.log('已生成本地合成评阅报告：' + args[0]);
  } catch (error) {
    console.error(error.code === 'EEXIST' ? '输出文件已存在，未覆盖。' : error.message);
    process.exitCode = 1;
  }
}
