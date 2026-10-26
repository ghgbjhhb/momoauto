'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { YunmomoClient } = require('../index');
const { PROJECT_ROOT } = require('../automation/runtime');

function normalized(config, line, defaults) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`第 ${line} 条不是代理对象`);
  if (config.id !== undefined && config.id !== '') throw new Error(`第 ${line} 条包含已有 ID；新增脚本不能修改已有线路`);
  const ip = String(config.ip ?? '').trim(), port = String(config.port ?? '').trim();
  const username = String(config.username ?? '').trim(), password = String(config.password ?? '').trim();
  if (!ip || /\s/.test(ip) || !username || !password) throw new Error(`第 ${line} 条缺少有效 IP/域名、用户名或密码`);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error(`第 ${line} 条端口必须为 1–65535`);
  return { ip, port, username, password, groupId: String(config.groupId ?? defaults.groupId ?? '').trim(),
    remarks: String(config.remarks ?? defaults.remarks ?? '').trim(), expTime: String(config.expTime ?? '').trim() };
}

function tailFields(value) {
  if (!value) return {};
  if (/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(value)) return { expTime: value + ' 00:00:00' };
  if (/^\d{13}$/.test(value)) {
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) throw new Error('过期时间无效');
    const pad = number => String(number).padStart(2, '0');
    return { expTime: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` };
  }
  return Number.isNaN(new Date(value).getTime()) ? { remarks: value } : { expTime: value };
}

function parseVpcData(text, defaults = {}) {
  const data = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!data) throw new Error('请提供代理数据：YUNMOMO_VPC_DATA 或 --file=<文件路径>');
  if (data.startsWith('{') || data.startsWith('[')) {
    let parsed;
    try { parsed = JSON.parse(data); } catch { throw new Error('代理 JSON 格式错误；未输出原文以免泄露密码'); }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    if (!rows.length) throw new Error('代理列表不能为空');
    return rows.map((row, index) => normalized(row, index + 1, defaults));
  }
  return data.split(/\r?\n/).map((value, index) => ({ value: value.trim(), line: index + 1 }))
    .filter(row => row.value).map(({ value, line }) => {
      let match, config;
      if ((match = value.match(/^([^:@]+):([^:@]+)@([^:@]+):(\d+)$/))) {
        config = { username: match[1], password: match[2], ip: match[3], port: match[4] };
      } else if ((match = value.match(/^([^:@]+):(\d+)@([^:@]+):([^:@]+)$/))) {
        config = { ip: match[1], port: match[2], username: match[3], password: match[4] };
      } else if ((match = value.match(/^([^|]+)\|(\d+)\|([^|]+)\|([^|]+)\|?(.*)$/))) {
        config = { ip: match[1], port: match[2], username: match[3], password: match[4], ...tailFields(match[5]) };
      } else if ((match = value.match(/^([^/]+)\/(\d+)\/([^/]+)\/([^/]+)\/?(.*)$/))) {
        config = { ip: match[1], port: match[2], username: match[3], password: match[4], ...tailFields(match[5]) };
      } else if ((match = value.match(/^([^:@]+):(\d+):([^:@]+):([^:@]+)$/))) {
        config = { ip: match[1], port: match[2], username: match[3], password: match[4] };
      } else throw new Error(`第 ${line} 行不是网页支持的代理格式；未提交任何线路`);
      return normalized(config, line, defaults);
    });
}

function safeRows(rows) {
  return rows.map(({ ip, port, groupId, remarks, expTime }) => ({ ip, port, groupId, remarks, expTime }));
}

async function main(argv = process.argv.slice(2)) {
  let execute = false, file = process.env.YUNMOMO_VPC_DATA_FILE;
  let groupId = process.env.YUNMOMO_VPC_GROUP_ID ?? '', remarks = process.env.YUNMOMO_VPC_REMARKS ?? '';
  for (const arg of argv) {
    if (arg === '--execute') execute = true;
    else if (arg === '--help') {
      console.log('增加VPC网络：--file=<代理文本或JSON文件> [--group-id=<已有分组ID>] [--remarks=<备注>] [--execute]');
      console.log('也支持 YUNMOMO_VPC_DATA（网页的五种格式/JSON）及 YUNMOMO_VPC_DATA_FILE；无 --execute 只预览。');
      console.log('新增后返回网络 ID，并保存无密码的 latest.json；不会自动设置到云机。');
      return;
    } else if (arg.startsWith('--file=')) file = arg.slice(7);
    else if (arg.startsWith('--group-id=')) groupId = arg.slice(11);
    else if (arg.startsWith('--remarks=')) remarks = arg.slice(10);
    else throw new Error('未知参数；请用 --help 查看，不要把代理密码写入命令行参数');
  }
  const text = file ? await fs.readFile(path.resolve(file), 'utf8') : process.env.YUNMOMO_VPC_DATA;
  const configs = parseVpcData(text, { groupId, remarks });
  if (!execute) {
    console.log(JSON.stringify({ status: 'preview', name: '增加VPC网络', count: configs.length,
      networks: safeRows(configs), credentials: '<用户名及密码已隐藏>', note: '未新增；加 --execute 才提交。' }, null, 2));
    return;
  }
  if (!process.env.YUNMOMO_TOKEN) throw new Error('请通过 YUNMOMO_TOKEN 提供当前登录令牌');
  const root = path.join(PROJECT_ROOT, '.local-output', 'VPC网络');
  await fs.mkdir(root, { recursive: true });
  const outputDir = await fs.mkdtemp(path.join(root, '新增-'));
  const reportPath = path.join(outputDir, 'report.json');
  const latestResultPath = path.join(root, 'latest.json');
  const report = { name: '增加VPC网络', ok: false, status: 'submitting', startedAt: new Date().toISOString(),
    count: configs.length, networks: safeRows(configs), reportPath };
  const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  await save();
  // Latest means latest attempt, not an old success after a failed new attempt.
  await fs.writeFile(latestResultPath, JSON.stringify(report, null, 2), 'utf8');
  try {
    const added = await new YunmomoClient().vpc().addAndGetIds(configs);
    Object.assign(report, { ok: true, status: 'created-and-verified', finishedAt: new Date().toISOString(),
      ...added, latestResultPath });
    await save();
    await fs.writeFile(latestResultPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
    if (added.vpcId) console.log(`后续设置线路：$env:YUNMOMO_VPC_ID = '${added.vpcId}'`);
  } catch (error) {
    Object.assign(report, { ok: false, status: 'not-confirmed', error: error.message,
      httpStatus: error.status, candidateIds: error.candidateIds,
      note: '未自动重发新增请求；先查看网页或候选 ID，避免重复添加。latest.json 已标为未确认，设置脚本不会读取旧线路。' });
    await save();
    await fs.writeFile(latestResultPath, JSON.stringify(report, null, 2), 'utf8');
    console.error(JSON.stringify(report, null, 2));
    throw error;
  }
}

main = require('../automation/timing').timedScript('script.src.workflows.add-vpc-network', main);

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseVpcData, main };
