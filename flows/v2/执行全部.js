'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { YunmomoClient } = require('../../src');
const { STEPS, PROJECT_ROOT, redact, runStep } = require('./_common');

async function writeReport(directory, report) {
  await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(report, null, 2));
  const statusName = { pending: '待执行', running: '执行中', completed: '完成', failed: '失败' };
  const lines = [
    '# 八步流程执行记录', '', `设备 ID：${report.deviceId}`, '',
    `开始时间（UTC）：${report.startedAt}`, '',
    '| 顺序 | 名称 | 状态 | 执行次数 | 最近耗时(ms) | 截图核对 |', '|---|---|---|---|---|---|',
    ...report.steps.map(step => `| ${step.order} | ${step.name} | ${statusName[step.status]} | ${step.attempts.length} | ${step.attempts.at(-1)?.durationMs ?? '-'} | ${step.review?.passed ? step.review.note : '待核对'} |`),
    '', '每次执行的日志、手机截图和 OCR 过程截图保存在对应步骤目录。',
    '第八步以点击“同意并继续”并停留在后续页面为协议分支的终点；此终点不代表后续键盘向导或最终讯飞切换已经完成。', '',
  ];
  await fs.writeFile(path.join(directory, '执行记录.md'), lines.join('\n'));
}

async function retainOcr(output, directory) {
  const match = output.match(/OCR screenshots kept at ([^\r\n]+)/);
  if (!match) return;
  const source = path.resolve(match[1].trim());
  const archived = path.relative(path.join(directory, 'ocr'), source);
  if (archived && !archived.startsWith('..') && !path.isAbsolute(archived)) return;
  const relative = path.relative(os.tmpdir(), source);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !/^yunmomo-script\d+-/.test(path.basename(source))) return;
  await fs.cp(source, path.join(directory, 'ocr'), { recursive: true, errorOnExist: true, force: false });
}

async function main() {
  if (!process.argv.includes('--execute')) throw new Error('执行完整流程请传入 --execute');
  const stepArgument = process.argv.find(argument => argument.startsWith('--step='));
  const reviewArgument = process.argv.find(argument => argument.startsWith('--review-step='));
  const onlyStep = stepArgument ? Number(stepArgument.slice('--step='.length)) : null;
  const reviewStep = reviewArgument ? Number(reviewArgument.slice('--review-step='.length)) : null;
  for (const value of [onlyStep, reviewStep]) {
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 8)) throw new Error('步骤编号必须为 1～8');
  }
  if (onlyStep !== null && reviewStep !== null) throw new Error('运行和截图核对必须分开执行');
  const deviceId = String(process.env.YUNMOMO_DEVICE_ID || '');
  if (!/^\d+$/.test(deviceId)) throw new Error('请用 YUNMOMO_DEVICE_ID 指定目标云机');
  if (!process.env.YUNMOMO_TOKEN) throw new Error('请设置 YUNMOMO_TOKEN');
  const client = new YunmomoClient({ timeoutMs: 100000 });
  const listed = await client.listDevices({ size: 50000 });
  if (!listed.records.some(device => String(device.deviceId ?? device.id) === deviceId)) throw new Error('目标设备不在当前账号中');
  const phone = client.device(deviceId);
  const root = path.join(PROJECT_ROOT, '.local-output', '流程执行');
  await fs.mkdir(root, { recursive: true });
  const resume = process.argv.includes('--resume');
  const version = 'v2';
  const stepsList = STEPS;
  let directory;
  let report;
  if (resume) {
    if (!process.env.YUNMOMO_RUN_DIR) throw new Error('继续执行需要 YUNMOMO_RUN_DIR 指向已有记录目录');
    directory = path.resolve(process.env.YUNMOMO_RUN_DIR);
    const relative = path.relative(root, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('记录目录必须位于项目的 .local-output/流程执行 内');
    report = JSON.parse(await fs.readFile(path.join(directory, 'results.json'), 'utf8'));
    if (report.deviceId !== deviceId) throw new Error('记录的设备与本次目标设备不一致');
  } else {
    directory = await fs.mkdtemp(path.join(root, `全流程-${version}-`));
    report = { deviceId, version, startedAt: new Date().toISOString(), steps: stepsList.map(step => ({ order: step.order, name: step.name, status: 'pending', attempts: [] })) };
    const initial = await phone.screenshot({ level: 2 });
    await fs.writeFile(path.join(directory, '初始页面.jpg'), initial.data);
  }
  console.log('运行目录：' + directory);
  if (reviewStep !== null) {
    if (!resume) throw new Error('截图核对必须指定已有记录目录并传入 --resume');
    const record = report.steps.find(step => step.order === reviewStep);
    if (record?.status !== 'completed') throw new Error('该步尚未执行完成，不能确认通过');
    const note = String(process.env.YUNMOMO_REVIEW_NOTE || '').trim();
    if (!note) throw new Error('请用 YUNMOMO_REVIEW_NOTE 记录实际核对结果');
    record.review = { passed: true, at: new Date().toISOString(), note: redact(note) };
    if (report.steps.every(step => step.status === 'completed' && step.review?.passed)) report.finishedAt = new Date().toISOString();
    await writeReport(directory, report);
    console.log(`已记录 ${reviewStep}/8 的核对结果；不会自动运行下一步。`);
    return;
  }
  if (onlyStep !== null) {
    report.mode = 'stepwise-review';
    if (report.steps.some(step => step.order < onlyStep && (step.status !== 'completed' || !step.review?.passed))) {
      throw new Error('前面的步骤必须完成并核对通过，才能运行下一步');
    }
  }
  delete report.finishedAt;
  await writeReport(directory, report);
  for (const step of stepsList) {
    if (onlyStep !== null && step.order !== onlyStep) continue;
    const record = report.steps.find(item => item.order === step.order);
    if (!record) throw new Error('执行记录缺少步骤：' + step.order);
    if (record.status === 'completed') continue;
    const attemptDirectory = await fs.mkdtemp(path.join(directory, `${String(step.order).padStart(2, '0')}-${step.name.replace(/\s/g, '')}-`));
    const attempt = { startedAt: new Date().toISOString(), directory: path.relative(directory, attemptDirectory), status: 'running' };
    const attemptStarted = performance.now();
    record.status = 'running';
    record.attempts.push(attempt);
    await writeReport(directory, report);
    let output = '';
    try {
      const result = await runStep(step.order, {
        env: { ...process.env, YUNMOMO_KEEP_OCR_SCREENSHOTS: '1', YUNMOMO_OCR_PARENT_DIR: path.join(attemptDirectory, 'ocr') },
        onOutput: text => { output += text; process.stdout.write(text); },
      }, version);
      await fs.writeFile(path.join(attemptDirectory, '运行日志.txt'), result.output);
      await retainOcr(result.output, attemptDirectory);
      const shot = await phone.screenshot({ level: 2 });
      await fs.writeFile(path.join(attemptDirectory, '完成页面.jpg'), shot.data);
      attempt.status = record.status = 'completed';
      attempt.finishedAt = new Date().toISOString();
      attempt.durationMs = Math.round((performance.now() - attemptStarted) * 100) / 100;
      await writeReport(directory, report);
      console.log(`完成 ${step.order}/8：${step.name}`);
    } catch (error) {
      attempt.status = record.status = 'failed';
      attempt.finishedAt = new Date().toISOString();
      attempt.durationMs = Math.round((performance.now() - attemptStarted) * 100) / 100;
      attempt.error = redact(error.message);
      await fs.writeFile(path.join(attemptDirectory, '运行日志.txt'), output);
      await retainOcr(output, attemptDirectory).catch(() => {});
      try {
        const shot = await phone.screenshot({ level: 2 });
        await fs.writeFile(path.join(attemptDirectory, '失败页面.jpg'), shot.data);
      } catch (shotError) { attempt.screenshotError = redact(shotError.message); }
      await writeReport(directory, report);
      throw error;
    }
  }
  if (report.steps.every(step => step.status === 'completed') && onlyStep === null) report.finishedAt = new Date().toISOString();
  await writeReport(directory, report);
  console.log(onlyStep === null ? '八个脚本已全部执行完成，记录目录：' + directory
    : `第 ${onlyStep} 步已结束，请核对日志和截图；没有运行下一步。`);
}

main = require('../src/automation/timing').timedScript('script.flows.执行全部', main);

main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
