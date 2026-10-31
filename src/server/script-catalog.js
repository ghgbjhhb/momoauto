'use strict';

const { STEPS: STEPS_V2 } = require('../../flows/v2/_common');
const { STEPS: STEPS_V3 } = require('../../flows/v3/_common');

const SCRIPT_DEFINITIONS = Object.freeze([
  // V2 版本初始化脚本 (01~09)
  ...STEPS_V2.map(step => ({
    id: 'flow-' + (Number.isInteger(step.order) ? String(step.order).padStart(2, '0') : String(step.order)) + '-v2',
    order: step.order,
    version: 'v2',
    category: 'v2',
    title: step.name,
    file: 'flows/v2/' + step.entry,
    args: ['--execute'],
    requiresDevice: true,
    requiresCertificate: step.order === 2,
    ...(step.order === 2.1 ? {
      parameters: [
        { name: 'filePath', label: '云盘真参文件', defaultValue: '', placeholder: '留空默认自动获取云盘可用真参' }
      ]
    } : {}),
    ...(step.order === 3 ? {
      parameters: [
        { name: 'action', label: '代理操作', choices: ['set', 'show', 'close'], defaultValue: 'set' }
      ]
    } : {}),
    ...(step.order === 6 ? {
      parameters: [
        { name: 'mode', label: '定位模式', choices: ['ip', 'search'], defaultValue: 'ip' },
        { name: 'address', label: '目标搜索地址', defaultValue: '' }
      ]
    } : {})
  })),
  {
    id: 'flow-09-v2', order: 9, version: 'v2', category: 'v2', title: '重置数据v2',
    file: 'flows/v2/09-重置数据.js', args: ['--execute', '--v2'], requiresDevice: true,
    destructive: true
  },
  {
    id: 'flow-all-v2', title: '执行全流程 (V2)', file: 'flows/v2/执行全部.js', args: ['--execute'],
    requiresDevice: true, requiresCertificate: true, batch: true, category: 'v2', version: 'v2'
  },

  // V3 版本初始化脚本 (01~09)
  ...STEPS_V3.map(step => ({
    id: 'flow-' + String(step.order).padStart(2, '0') + '-v3',
    order: step.order,
    version: 'v3',
    category: 'v3',
    title: step.name,
    file: 'flows/v3/' + step.entry,
    args: ['--execute'],
    requiresDevice: true,
    requiresCertificate: step.order === 2,
    ...(step.order === 3 ? {
      parameters: [
        { name: 'action', label: '代理操作', choices: ['set', 'show', 'close'], defaultValue: 'set' }
      ]
    } : {})
  })),
  {
    id: 'flow-09-v3', order: 9, title: '改机重置v3',
    file: 'flows/v3/09-改机重置.js', args: ['--execute', '--v3'], requiresDevice: true,
    destructive: true,
    version: 'v3',
    category: 'v3',
    parameters: [
      { name: 'androidVersion', label: '安卓版本', choices: ['16', '14', '10', 'all'], defaultValue: '16' },
      { name: 'countryCode', label: '国家代码', defaultValue: 'CN', maxLength: 2 }
    ]
  },

  // MOMO 业务自动化 (11~15)
  {
    id: 'flow-11', order: 11, title: 'MOMO首页养号',
    file: 'flows/momo/11-momo首页养号.js', args: ['--execute'], requiresDevice: true,
    category: 'momo',
    version: 'v2',
    parameters: [
      { name: 'cycles', label: '循环轮数', choices: ['1', '2', '3', '5', '10'], defaultValue: '1' },
      { name: 'mode', label: '刷新方式', choices: ['random', 'button', 'pull'], defaultValue: 'random' }
    ]
  },
  {
    id: 'flow-12', order: 12, title: 'MOMO收到的招呼处理',
    file: 'flows/momo/12-momo招呼处理.js', args: ['--execute'], requiresDevice: true,
    category: 'momo',
    parameters: [
      { name: 'maxApproved', label: '目标通过人数', choices: ['3', '5', '6', '10', '15', '20'], defaultValue: '6' },
      { name: 'maxDistance', label: '距离筛选', choices: ['none', '3', '5', '10', '20', '50'], defaultValue: 'none' },
      { name: 'approveProbability', label: '通过概率', choices: ['0.9', '0.8', '0.95', '1.0'], defaultValue: '0.9' }
    ]
  },
  {
    id: 'flow-13', order: 13, title: 'MOMO联系人及消息入库',
    file: 'flows/momo/13-momo联系人及消息入库.js', args: [], requiresDevice: true,
    category: 'momo',
    parameters: [
      { name: 'contactName', label: '当前聊天联系人姓名（必填）', required: true, maxLength: 120 }
    ]
  },
  {
    id: 'flow-14', order: 14, title: 'MOMO AI 自动回复',
    file: 'flows/momo/14-momoAI回复.js', args: [], requiresDevice: true,
    category: 'momo',
    parameters: [
      { name: 'mode', label: '运行模式', choices: ['execute', 'draft'], defaultValue: 'execute' },
      { name: 'contactName', label: '指定联系人姓名', defaultValue: '', placeholder: '留空自动扫描未读联系人', maxLength: 120 }
    ]
  },
  {
    id: 'flow-15', order: 15, title: 'MOMO监听中枢',
    file: 'flows/momo/15-momo监听中枢.js', args: [], requiresDevice: true,
    category: 'momo',
    parameters: [
      { name: 'mode', label: '运行模式', choices: ['watch', 'drain'], defaultValue: 'watch' },
      { name: 'maxContacts', label: '处理人数上限', choices: ['xx', '1', '3', '5', '10'], defaultValue: 'xx' },
      { name: 'maxGreetings', label: '招呼处理单次上限', choices: ['3', '5', '10'], defaultValue: '5' },
      { name: 'warmupInterval', label: '首页养号间隔', choices: ['default', '0', '60000', '300000'], defaultValue: 'default' },
      { name: 'greetingsInterval', label: '招呼处理间隔', choices: ['0', '1200000', '1800000'], defaultValue: '0' }
    ]
  },
  {
    id: 'flow-16', order: 16, title: '陌陌一键上号',
    file: 'flows/momo/16-momo一键上号.js', args: ['--execute'], requiresDevice: true,
    category: 'momo',
    version: 'v2',
    parameters: [
      { name: 'yayaMode', label: '丫丫授权模式', choices: ['direct', 'relogin'], defaultValue: 'direct' },
      { name: 'targetTime', label: '丫丫复扫订单时间', defaultValue: '16:05', placeholder: '如 16:05，匹配历史订单' },
      { name: 'nickname', label: '女生网名', defaultValue: '菲菲菲', placeholder: '设置女生昵称，默认菲菲菲' },
      { name: 'phoneNumber', label: '绑定手机号', defaultValue: '17306728814', placeholder: '输入待绑定的 11 位手机号（默认17306728814）' },
      { name: 'verifyCode', label: '短信验证码', defaultValue: '', placeholder: '留空表示自动获取并等待输入；输入 6 位验证码直接提交' }
    ]
  },
  {
    id: 'flow-18', order: 18, title: 'MOMO拉黑当前联系人',
    file: 'flows/momo/18-momo拉黑当前联系人.js', args: [], requiresDevice: true,
    category: 'momo',
    destructive: true,
    parameters: [
      { name: 'contactName', label: '当前聊天联系人姓名（必填，防止误拉黑）', required: true, maxLength: 120 }
    ]
  },
  {
    id: 'flow-all', title: '执行全流程 (V3)', file: 'flows/v3/执行全部.js', args: ['--execute'],
    requiresDevice: true, requiresCertificate: true, batch: true, category: 'all', version: 'v3'
  }
].map(Object.freeze));

function scriptById(id) {
  let script = SCRIPT_DEFINITIONS.find(item => item.id === id);
  if (!script && id && /^flow-0[1-9]$/.test(id)) {
    // 兼容旧版不带后缀的 id，默认匹配 v3
    script = SCRIPT_DEFINITIONS.find(item => item.id === id + '-v3');
  }
  if (!script) throw new Error('未知脚本');
  return script;
}

module.exports = { SCRIPT_DEFINITIONS, scriptById };
