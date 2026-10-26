# 云盘与 VPC 管理接口（0.3.0）

入口：`client.cloudDisk()`、`client.vpc()`、`client.vpc().groups()`。本地调用只在方法执行时发请求，不启动后台任务、不自动修改设备；均复用当前 client 的 token、baseUrl、超时和请求范围保护。此处的 VPC 是网页保存的代理线路管理，不是云厂商的子网/路由 API。

~~~js
const { YunmomoClient } = require('D:/AA-project/自动化');
const client = new YunmomoClient({ token: process.env.YUNMOMO_TOKEN });
const disk = client.cloudDisk();
const vpc = client.vpc();
const files = await disk.list();
const publicFiles = await disk.list({ channel: '2' });
const usage = await disk.usage();
const lines = await vpc.list();
const groups = await vpc.groups().list();
console.log({ files: files.total, publicFiles: publicFiles.total, usedBytes: usage.fileSizeTotal, lines: lines.total });
~~~

所有文件、设备、线路、分组 ID 都用字符串，尤其 19 位编号不能用 Number。`list` 返回 `{records,total,current,size,pages,raw}`；其余方法保持后端原始 JSON，不伪造成功状态。所有方法支持独立请求选项 `{timeoutMs,signal,headers}`；list 的请求选项是第二个参数，upload/import/send 的请求选项合并在业务 options 中。查询失败会抛错；token 不进入 JSON 对象日志，网络错误不含 URL 或凭据。

## 云盘

下面 F 表示 `/screen/file/scFile/`，T 表示 `/screen/file/scFileTransfer/`，路径都相对于默认后端 `https://cloud.yunmomo.com/backend`。

| 方法 | 实际请求 | 参数/返回 |
| --- | --- | --- |
| list(options?, requestOptions?) | GET F + list | page=1、size=10000、channel='1'、fileType=''、orders；返回分页结构 |
| get(id) | GET F + queryById | id；返回文件记录 |
| usage('1') / usage() | GET F + getFileUseDetail | `{fileSizeTotal,fileTypeCount}`，字节用量与分类计数 |
| usage('2') | GET F + getPublicFileUseDetail | `{filePublicSizeTotal,filePublicTypeCount}` |
| upload(data, options) | POST F + save / publicSave | multipart file；public=true 选择公共上传，需账号权限 |
| rename(id, name) | POST F + rename | JSON `{id,name}` |
| delete(ids) | DELETE F + delete | query ids，数组自动转逗号分隔字符串 |
| resolveUrl(fileOrDownloadUrl) | GET /file/preview | 从记录 url 解析 uploadPath、name，返回供云机读取的 URL |
| sendToDevices(deviceIds, files, options) | POST F + send | 先解析文件 URL，提交 `{devices,urls,fileType}` |
| transferStatus() | GET F + send/status | 普通传输任务状态，可能为 null |
| sendPairs(pairs, options?) | POST T + sendPairs | `{fileType,pairs:[{seq,deviceId,fileId,fileName}]}`，seq 自动从 1 开始 |
| pairStatus() | GET T + status | 一机一传任务状态；无任务时实测为 null |
| clearPairStatus() | DELETE T + status | 清理一机一传状态；不代表取消传输 |
| importExcel(data, options) | POST F + import | multipart file，文件名后缀 csv/xls/xlsx |
| exportExcel(query) | GET F + export | 原导出表单查询参数；返回二进制 |
| exportTemplate() | GET F + import/template | 返回二进制 |

channel `'1'` 为我的文件，`'2'` 为公共文件；public=true 只影响上传端点，不更改 list 的默认 channel。分类值以网页字典为准，已观察到 apk、image、video、file、office、audio。sort 支持 default/time/size/name，对应原网页的默认/时间降序/大小降序/名称升序；可提供 orders 覆盖。云盘新页面原样发送 page；旧文件中转站则使用 current，不把两种分页字段混写。需要更精细的旧中转站查询时使用 `client.request` 原始接口。

usage 没有返回总容量；页面总容量来自账户配置，不能把 fileSizeTotal 当容量，也不能硬编码所有账号为 5GB。“扩容云盘”按钮目前只显示“敬请期待”，源码没有提交接口，SDK 不提供虚构的扩容方法。

~~~js
// 下列写方法会真正影响云盘/云机，按需调用，不是自动运行的测试。
await disk.upload(Buffer.from('example'), { fileName: 'example.txt' });
await disk.rename('文件ID', 'example-renamed.txt');
await disk.sendToDevices(['设备ID'], ['文件ID'], { fileType: 'download' });
await disk.sendPairs([{ deviceId: '设备ID', fileId: '文件ID', fileName: 'example.txt' }], { fileType: 'download' });
const status = await disk.pairStatus();
if (status === null) console.log('没有一机一传任务');
else console.log({ finished: status.finished, failed: status.failCount });
~~~

upload 接受 Buffer/Uint8Array/Blob，fileName 必填；可用 fields 传补充的原始 multipart 字段，不能覆盖 file。默认超时 1 小时，与网页一致。私有云盘网页上传器只提交 file，无额外必填业务表单；实际上传/权限/配额仍由服务端校验。旧 `client.uploadCloudFile` 保持兼容。

sendToDevices 的 files 是文件记录或文件 ID 数组；ID 会先查询详情，记录 URL 支持相对路径。解析失败不会发送。普通传输是把每个文件发给每台设备；一机一传每台一个文件，1–50 对，文件 ID、设备 ID 各自不能重复，SDK 保留调用顺序。fileType 为自动化业务选项，普通传输必填；一机一传默认 auto，与网页一致。已确认 auto/download/image/install，另有 uploadV3/installV3 分支只适用于 V3。auto/install 可能安装应用；想单纯落下载目录应显式用 download。

任务接口返回当前账户的任务快照，没有任意 taskId 查询或自动轮询保证；网页约每 3 秒查询。提交成功不代表传输/安装完成，查看 finished、details、successCount、failCount、expired。任务状态/URL/错误详情可能含私有信息，不要全量写日志。

delete 是页面真正使用的 `/screen/file/scFile/delete`；不要假设它只是删除数据库记录、可恢复或必然只删存储。源码还有低层 `/file/delete` 包装，但其本页面调用参数未确认，未暴露混淆的另一删除方法。

## VPC 线路

以下 V 表示 `/screen/vpc/scVpc/`。

| 方法 | 实际请求 | 参数/返回 |
| --- | --- | --- |
| list(options?, requestOptions?) | GET V + list | current=1、size=10、ip=''、remarks=''、groupId=''、orders |
| get(id) | GET V + queryById | id；返回含 username/password 的原始线路记录 |
| save(config) | POST V + save | JSON 对象；无 id/空 id 新建，有 id 修改 |
| batchSave(configs) | POST V + batchSave | JSON 数组，不是 `{records:[]}` 或原始文本 |
| delete(ids) | DELETE V + delete | query ids，逗号分隔 |
| testConnection(id) | GET V + testById | 返回布尔测试结果；会访问线路，不是纯查询 |
| groups() | 不发请求 | 返回 VpcGroupManager |
| importExcel(data, options) | POST V + import | multipart file，csv/xls/xlsx |
| exportExcel(query) | GET V + export | 原导出表单查询参数；返回二进制 |
| exportTemplate() | GET V + import/template | 返回二进制 |

save 必填 ip、port、username、password，与网页表单一致。ip 支持域名；port 为 1–65535 的整数/数字字符串，提交为字符串。可传 id、expTime（`YYYY-MM-DD HH:mm:ss`）、userId、groupId、remarks。单条保存的空字段与网页一致；批量保存保留 JSON 数组与每条记录字段，groupId/remarks 默认空，不上传未核对的“原始代理文本”字段。

list 的 groupId `''` 查全部，`'none'` 查未分组，具体分组 ID 查该组。默认 orders 是 create_date 降序、id 降序，保留网页 qs 编码：`orders[0].column` 等。

~~~js
// 保存线路不会自动将该线路设置到某台云机。
await vpc.save({
  ip: '你的代理域名', port: 1080,
  username: process.env.PROXY_USERNAME, password: process.env.PROXY_PASSWORD,
  groupId: '', remarks: '自动化线路'
});
// 要修改已有线路，传已有 id；删除需要显式调用 vpc.delete(ids)。
~~~

`vpc.save` 维护网页列表；`phone.setProxy` 才修改云机当前代理，两者参数不同（ip/port/username/password 对比 s5ip/s5port/s5user/s5pwd），SDK 不隐式串联这两步。VPC records 和导出表可能含明文线路凭据，请勿直接打印或提交版本库。

### 新增并获得网络 ID

`await vpc.addAndGetIds(configOrArray)` 使用与“新建VPC设置”相同的 `batchSave` JSON 数组，拒绝传已有 `id`。保存前记录现有 ID，保存后分页查询同主机线路，按连接凭据、分组、备注及显式有效期匹配新 ID，再调用 `get(id)` 确认。结果为 `{ids, results, vpcId?}`，`results` 只含 `vpcId/ip/port/groupId/remarks/expTime`，不含用户名或密码；单条时有 `vpcId`。

新增只提交一次；之后最多查询 10 次，每次间隔 1 秒，可用 `lookupAttempts/lookupIntervalMs` 调整。多个新增候选或未查到唯一 ID 时抛错，错误的 `candidateIds` 可用于人工核查，不能自动重发新增请求。执行入口 `flows/10-增加VPC网络.js` 接收网页文本或 JSON；设置云机代理时传 `YUNMOMO_VPC_ID`，或通过 `YUNMOMO_VPC_RESULT_PATH` 读取已成功且单条的结果文件，详见 `flows/README.md`。

## VPC 分组

以下 G 表示 `/screen/vpc/scVpcGroup/`。

| 方法 | 实际请求 | 参数 |
| --- | --- | --- |
| list(options?, requestOptions?) | GET G + list | current=1、size=-1，返回 records/total 等 |
| get(id) | GET G + queryById | id |
| save({name,id?}) | POST G + save | 无 id 新建，有 id 修改；name trim |
| delete(ids, options?) | DELETE G + delete | query ids、mode；默认 mode='keep' |

mode='keep' 删除组但保留其线路，归为未分组；mode='delete' 同时删除组内线路。SDK 只接受这两个值；调用前应核实目标，不能把“删除组”当作可恢复操作。测试没有创建或删除实际分组。

## Excel 返回和验证边界

exportExcel 接受 current、size、orders、业务筛选，以及 filename、sheetName、isHeader、original、mode、selectIds、exportFields，保留网页原字段；SDK 不自动推测导出字段。返回 `{data:Buffer,contentType,status}`，JSON/HTML 错误文档不会冒充表格。示例：

~~~js
const sheet = await vpc.exportExcel({
  current: 1, size: 10, mode: 'current', filename: 'VPC', sheetName: 'VPC',
  isHeader: true, original: false, selectIds: [],
  exportFields: ['ip', 'port', 'username', 'password', 'expTime', 'remarks']
});
// sheet.data 可能包含密码，保存到受控路径；不要记录内容。
~~~

30 个路径/方法描述见导出的 MANAGEMENT_ACTIONS；描述表用于接口清单，调用使用上述命名空间方法，不是 `client.invoke` 的新动作。真实账号只读验证范围和没有执行的写操作见 [实测报告](MANAGEMENT-LIVE-TEST-2026-10-12.md)。公开前端是非正式 API 证据，平台升级、权限和服务端业务限制仍可能改变行为。
