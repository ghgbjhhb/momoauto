# 云盘全量传输流程（2026-10-12）

## 实机网页验证

第三台 SF 的设备编号为 `2030225672674516993`，网页传输列表显示云号 `GVIP560454730527`。

1. 打开“云盘”，停留在“我的文件”。
2. 点击“全选”，当前私有文件数为 8。
3. 点击“传输至云机”。
4. 在设备列表选择第 3 台：`GVIP560454730527`。
5. 上传方式保持“自动类型识别”。
6. 点击“确认上传”。
7. 打开“传输列表”核对结果：总计 8、成功 8、失败 0，8 条明细均为“已完成”。

## SDK 等价流程

可复用脚本：`examples/send-all-cloud-files.js`。

```powershell
$env:YUNMOMO_TOKEN = '<当前登录令牌>'
$env:YUNMOMO_DEVICE_ID = '2030225672674516993'
$env:YUNMOMO_CONFIRM_SEND = 'YES'
npm run send:all-cloud-files
```

脚本执行顺序与网页一致：

`listDevices → cloudDisk.list(channel=1) → sendToDevices(fileType=auto) → transferStatus 轮询 → 校验成功数/失败数`。

脚本默认要求 `YUNMOMO_CONFIRM_SEND=YES`，防止重复运行导致同一批文件再次传输；`YUNMOMO_VERIFY_ONLY=1` 只读取设备、云盘和当前传输状态，不发起新任务。

令牌只从环境变量读取，脚本不打印文件 URL、令牌或完整后端响应。

## 本轮 SDK 实机结果

网页传输完成后，先用同一账号令牌执行了只读复核模式：

```text
targetDeviceId: 2030225672674516993
cloudFileCount: 8
transferStatus: finished=true, expired=false, totalCount=8, successCount=8, failCount=0
```

这确认了 SDK 的设备列表、云盘列表和传输状态接口能读取当前真实任务。脚本中的真实写入路径由 `YUNMOMO_CONFIRM_SEND=YES` 显式保护。

随后按用户要求实际执行了 SDK 写入路径 `sendToDevices`，目标仍为第三台设备，使用 `fileType=auto`。SDK 轮询结果为：

```text
targetDeviceId: 2030225672674516993
cloudFileCount: 8
transfer: finished=true, expired=false, totalCount=8, successCount=8, failCount=0, pendingCount=0
SDK cloud-disk transfer OK
```

这次实际调用会在第三台云机产生第二批传输记录；网页端首次传输和 SDK 第二次传输均未出现失败。

## 第一台补充实测

按同一脚本将目标切换为第一台：

```text
deviceId: 2033060279606353921
cloudNo: GVIP462952588990
cloudFileCount: 8
transfer: finished=true, expired=false, totalCount=8, successCount=8, failCount=0, pendingCount=0
SDK cloud-disk transfer OK
```

## 第二步：上传谷歌证书

第三台设备仍为 `2030225672674516993`（云号 `GVIP560454730527`）。固定目标入口为
`examples/upload-google-certificate-to-third.js`，调用 SDK 的
`POST /screen/device/scDevice/uploadGoogleCert`，表单字段为 `file` 和
`deviceList`。

```powershell
$env:YUNMOMO_TOKEN = '<当前登录令牌>'
$env:YUNMOMO_DEVICE_ID = '2030225672674516993'
$env:YUNMOMO_CERT_PATH = 'C:\Users\Administrator\Documents\app\keybox(2)(1) (1).xml'
$env:YUNMOMO_CONFIRM_CERT_UPLOAD = 'YES'
npm run upload:google-cert:third
```

本次实测结果：

```text
targetDeviceId: 2030225672674516993
fileName: keybox(2)(1) (1).xml
bytes: 13264
SDK uploadGoogleCertificate: OK
```

接口返回成功表示云端已接受上传请求；当前接口返回的是非结构化文本，没有额外的“证书已在 Android 内生效”状态字段，因此不把上传回执等同于应用内激活完成。

## 第一台证书上传实测

第一台使用独立入口 `examples/upload-google-certificate-to-first.js`，目标为
`2033060279606353921`（云号 `GVIP462952588990`）。设置
`YUNMOMO_CONFIRM_CERT_UPLOAD=YES` 后执行 `npm run upload:google-cert:first`，实际返回：

```powershell
$env:YUNMOMO_CONFIRM_CERT_UPLOAD = 'YES'
npm run upload:google-cert:first
```

```text
targetDeviceId: 2033060279606353921
fileName: keybox(2)(1) (1).xml
bytes: 13264
SDK uploadGoogleCertificate: OK
```

## 第三步：第一台设置 VPC 代理

固定目标脚本为 `examples/set-vpc-proxy-to-first.js`，对应网页流程：打开云机右侧
`vpc代理` → `设置代理(新)` → 选择线路 → `设置V1`。脚本默认选择当前账号第一条未过期线路，
也可以用 `YUNMOMO_VPC_ID` 指定线路 ID。

```powershell
$env:YUNMOMO_CONFIRM_VPC_PROXY = 'YES'
npm run set:vpc-proxy:first
```

脚本映射字段如下：

`VPC.ip/port/username/password → phone.setProxy({s5ip,s5port,s5user,s5pwd}, 'v1')`，
并按网页默认值传入字符串 `domainMode='0'`（不启用域名解析）、
`proxyMode='2'`（tun2socks）以及所选线路的 `expTime`。

本次先在网页上完成了第一台实机操作，再用 SDK 脚本实际调用同一条线路。选中的线路为
`dy31.dayuip.com:47890`，第一台云机卡片随后显示该代理；接口返回无 HTTP/业务错误。

## 第四步：第一台环境配置（密钥认证）

固定目标入口为 `examples/environment-config-to-first.js`，对应以下视频流自动化流程：

1. 发送 Android HOME；
2. 用本地 RapidOCR 识别至少两个桌面锚点（例如“时钟”“日历”“通讯录”），确认当前已经回到桌面；
3. 在当前桌面识别“密钥认证”，找不到时左右翻页继续扫描；
4. 点击应用并等待“谷歌硬件根证书”和“引导加载程序已锁定”同时出现；
5. 再次发送 HOME，并确认桌面锚点恢复。

脚本复用了本项目之前测试通过的 RapidOCR 1.2.3 + OpenCV/ONNX Runtime，OCR 只读取本地截图，
不把手机画面上传到外部视觉服务。脚本会忽略短暂的“已复制”剪切板提示；点击文字标签没有打开应用时，
会自动在标签上方的图标区域重试一次。默认保留失败时的 HOME 收尾动作，便于后续流程从桌面开始。

```powershell
$env:YUNMOMO_TOKEN = '<当前登录令牌>'
$env:YUNMOMO_CONFIRM_ENV_CONFIG = 'YES'
npm run configure:environment:first
```

OCR 测试依赖保存在 `.local-output/vision-test/`（该目录被 `.gitignore` 忽略）。若需保留本次截图诊断，
执行前设置 `$env:YUNMOMO_KEEP_OCR_SCREENSHOTS='1'`；脚本不会输出令牌。

## 第五步：第一台生成全部数据

固定目标入口为 `examples/generate-all-data-to-first.js`。它复用第四步的主页锚点、左右翻页、
剪切板提示处理、RapidOCR 坐标换算和应用点击重试逻辑，目标应用是“伍羊工具箱”。流程为：

1. HOME 后确认桌面锚点；
2. OCR 找到“伍羊工具箱”，找不到时左右翻页；
3. 打开后确认标题“伍羊工具箱”和按钮“一键生成全部”；
4. 点击“一键生成全部”；
5. 必须先 OCR 观察到“正在生成/生成中”等中间状态；如果 Android 弹出“正在发送短信/是否允许”确认框，自动点击“允许”，并继续等待后续项目；
6. 只有抓到“所有数据生成完成/成功”提示，或按钮恢复后持续静默 15 秒且没有新的生成/短信弹窗，才判定全部完成；
7. 返回主页并再次确认桌面锚点。

该步骤会在第一台云机内生成联系人、通话记录等数据，默认需要显式确认：

```powershell
$env:YUNMOMO_TOKEN = '<当前登录令牌>'
$env:YUNMOMO_CONFIRM_GENERATE_ALL = 'YES'
npm run generate:all:first
```

脚本等待生成的默认上限为 120 秒，可用 `$env:YUNMOMO_GENERATION_TIMEOUT_MS` 调整；
失败时默认发送 HOME 收尾，不输出令牌。

