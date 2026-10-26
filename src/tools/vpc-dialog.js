'use strict';

const { spawn } = require('node:child_process');
const readline = require('node:readline');

/**
 * 弹出 Windows GUI 窗口输入 VPC 代理
 * 标题：识别vpc代理
 * 格式支持：
 * 1. 线路用户名:线路密码@线路IP:线路端口
 * 2. 线路IP:线路端口@线路用户名:线路密码
 * 3. 线路IP:线路端口:线路用户名:线路密码
 * 4. 线路IP|线路端口|线路用户名|线路密码|线路备注
 * 5. 线路IP/线路端口/线路用户名/线路密码/线路备注
 */
function showVpcDialog(options = {}) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      return reject(new Error('当前非 Windows 系统，无法弹出 Windows GUI 对话框'));
    }

    const defaultText = String(options.defaultText || '').trim();
    const escapedDefault = defaultText.replace(/`/g, '``').replace(/"/g, '`"');

    const psCode = `
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "识别vpc代理"
$form.Size = New-Object System.Drawing.Size(580, 430)
$form.StartPosition = "CenterScreen"
$form.TopMost = $true
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false

$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Location = New-Object System.Drawing.Point(20, 15)
$lblTitle.Size = New-Object System.Drawing.Size(520, 25)
$lblTitle.Font = New-Object System.Drawing.Font("Microsoft YaHei", 10, [System.Drawing.FontStyle]::Bold)
$lblTitle.Text = "请输入或粘贴 VPC 代理："
$form.Controls.Add($lblTitle)

$lblFormats = New-Object System.Windows.Forms.Label
$lblFormats.Location = New-Object System.Drawing.Point(20, 45)
$lblFormats.Size = New-Object System.Drawing.Size(520, 120)
$lblFormats.Font = New-Object System.Drawing.Font("Microsoft YaHei", 9)
$lblFormats.ForeColor = [System.Drawing.Color]::FromArgb(70, 70, 70)
$lblFormats.Text = "支持以下 5 种格式（设置前将自动添加一条，并设置为本机代理）：\`r\`n" +
  "① 线路用户名:线路密码@线路IP:线路端口\`r\`n" +
  "② 线路IP:线路端口@线路用户名:线路密码\`r\`n" +
  "③ 线路IP:线路端口:线路用户名:线路密码\`r\`n" +
  "④ 线路IP|线路端口|线路用户名|线路密码|线路备注\`r\`n" +
  "⑤ 线路IP/线路端口/线路用户名/线路密码/线路备注"
$form.Controls.Add($lblFormats)

$txtInput = New-Object System.Windows.Forms.TextBox
$txtInput.Location = New-Object System.Drawing.Point(20, 175)
$txtInput.Size = New-Object System.Drawing.Size(520, 110)
$txtInput.Multiline = $true
$txtInput.ScrollBars = "Vertical"
$txtInput.Font = New-Object System.Drawing.Font("Consolas", 10)
$txtInput.Text = "${escapedDefault}"
$form.Controls.Add($txtInput)

$btnOk = New-Object System.Windows.Forms.Button
$btnOk.Location = New-Object System.Drawing.Point(330, 310)
$btnOk.Size = New-Object System.Drawing.Size(100, 35)
$btnOk.Text = "确定"
$btnOk.Font = New-Object System.Drawing.Font("Microsoft YaHei", 9)
$btnOk.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.AcceptButton = $btnOk
$form.Controls.Add($btnOk)

$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Location = New-Object System.Drawing.Point(440, 310)
$btnCancel.Size = New-Object System.Drawing.Size(100, 35)
$btnCancel.Text = "取消"
$btnCancel.Font = New-Object System.Drawing.Font("Microsoft YaHei", 9)
$btnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.CancelButton = $btnCancel
$form.Controls.Add($btnCancel)

$form.Add_Shown({
    $txtInput.Focus()
    if ($txtInput.Text.Length -gt 0) {
        $txtInput.SelectAll()
    }
})

$result = $form.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    $trimmed = $txtInput.Text.Trim()
    if ($trimmed.Length -gt 0) {
        [Console]::Out.Write($trimmed)
        exit 0
    }
}
exit 2
`;

    const encoded = Buffer.from(psCode, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('error', err => reject(err));
    child.on('close', code => {
      const output = stdout.trim();
      if (code === 0 && output) {
        resolve(output);
      } else {
        reject(new Error('用户取消了 VPC 代理输入或未输入有效数据'));
      }
    });
  });
}

/**
 * 终端降级交互读取
 */
function promptTerminal(query = '请输入 VPC 代理（5 种格式之一）：') {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(query + '\n> ', answer => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) reject(new Error('未在终端输入 VPC 代理'));
      else resolve(trimmed);
    });
  });
}

/**
 * 获取 VPC 代理输入（支持环境变量优先、弹窗输入、终端降级）
 */
async function promptVpcProxy(options = {}) {
  // 1. 若环境变量已有显式数据（例如非交互环境或测试），优先使用
  const envData = String(process.env.YUNMOMO_VPC_DATA || options.vpcData || '').trim();
  if (envData) return envData;

  // 2. Windows 环境下默认弹窗
  if (process.platform === 'win32' && process.env.YUNMOMO_SKIP_POPUP !== '1') {
    try {
      return await showVpcDialog(options);
    } catch (error) {
      // 若用户主动点击取消，抛出取消异常停止流程
      if (error.message.includes('用户取消')) throw error;
      // 若弹窗进程启动异常且处于 TTY 终端，尝试控制台降级
      if (process.stdin.isTTY) {
        return await promptTerminal();
      }
      throw error;
    }
  }

  // 3. 非 Windows 或显式跳过弹窗且在交互终端
  if (process.stdin.isTTY) {
    return await promptTerminal();
  }

  throw new Error('未提供 YUNMOMO_VPC_DATA，且无法打开弹窗交互输入');
}

module.exports = {
  showVpcDialog,
  promptTerminal,
  promptVpcProxy
};
