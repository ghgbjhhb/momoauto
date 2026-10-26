# 云盘 / VPC 接口核对与实测（2026-10-12）

版本 0.3.0，Windows、Node.js 24.19.0。使用用户当前已登录的 Chrome 及其云机连接页面中已有的会话令牌；令牌只在临时运行进程内存中使用，收尾已清空，未写入源码、环境配置或测试报告。没有新增登录方式、权限或网络暴露。

## 真实账号验证

实际请求通过新 SDK 的 `CloudDisk`、`VpcManager` 发到云momo原有后端，不使用伪造响应。仅保留计数、键名及匹配布尔值；未记录文件名/下载地址、线路用户名/密码或返回正文。

| 检查 | 结果 |
| --- | --- |
| cloudDisk.list() 私有文件 | records=8，total=8 |
| cloudDisk.list({channel:'2'}) 公共文件 | records=25，total=25 |
| cloudDisk.usage() | fileSizeTotal=741142500 字节，包含 fileTypeCount，与网页约 706.81 MB 对应 |
| cloudDisk.usage('2') | 返回 filePublicSizeTotal、filePublicTypeCount |
| cloudDisk.get(id) | 现有文件 ID 与返回 ID 一致 |
| cloudDisk.resolveUrl(record) | 相对下载路径解析成功，返回 HTTP(S) URL；只解析链接，没有下载文件正文或推送到手机 |
| cloudDisk.transferStatus() | 正常返回任务快照，finished=true、expired=false |
| cloudDisk.pairStatus() | 返回 null，代表当前没有一机一传任务，非请求失败 |
| vpc.list() | records=5，total=5 |
| vpc.get(id) | 现有线路 ID 与返回 ID 一致，密码留在内存、不输出 |
| vpc.groups().list() | records=[]，total=0；没有现存组可验证 get(id) |

后台分页返回在 JSON 根部为 `{current,pages,records,size,total}`，不是必须包在 data 内；SDK 同时兼容可选的 data 包装。网页私有云盘总容量显示 5.00 GB，但用量接口没有总容量字段，所以 SDK 没有硬编码容量。

## 实测发现与修复

- 初始链接解析只接受绝对 URL，而账号文件 url 是相对路径；以配置的 backend URL 为基准解析后，真实 `/file/preview` 返回成功。
- 一机一传状态在没有任务时返回 null；类型声明与只读示例改为可空，不把它报告为 API 失败或访问其属性。
- DELETE 的 IDs 与 mode 是查询参数；VPC batchSave 是 JSON 数组；上传让 fetch 设置 multipart boundary。均按网页请求构造实现并本地测试。

## 未执行的真实写操作

未上传、删除、重命名现有云盘文件，未向设备发文件、安装软件或清理任务状态；未新建/修改/删除 VPC 线路或分组，未导入表格、调用线路连接测试或更改云机当前代理。导出表格/模板接口也未做真实下载验证。相关代码已核对公开前端方法与参数并通过本地模拟请求测试，不能声称服务端业务全链路验证通过。

当前 VPC 页面原样保留，临时云机窗口已关闭；本轮未改变手机配置、代理或文件。

## 证据来源与复现

浏览器实际云盘地址是 `/cloud/index`，不是旧的 `/screen/file/ScFileList`；VPC 地址是 `/screen/vpc/ScVpcList`。先核对可见功能，再从同站公开 webpack runtime/component map 解析对应脚本 URL，读取静态调用点。当前工具没有网络抓包/Hook 能力，本报告不把静态源码与 SDK 实测表述成已抓获浏览器原始网络包。

| 官方公开脚本 | 关键调用点 | SHA-256 |
| --- | --- | --- |
| [5445.a10657c5.js](https://cloud.yunmomo.com/js/5445.a10657c5.js) | CloudStorage 62171；refreshList page/channel/orders、getFileUseInfo、handleDelete、handleRenameConfirm、handleTransfer | DF0D8112A29A0AFC3120B8947975F550B30CAFA0C4A9262111A76799AC2877D0 |
| [1694.ff24edb4.js](https://cloud.yunmomo.com/js/1694.ff24edb4.js) | UploadDrawer 11694、scFile API 89695；私有 save / 公共 publicSave | 39B1060D3D1CDA07CD41DED5BDFCABC0EC412CA9CAC20EA7452EFA3B2E3F7829 |
| [6821.625acfeb.js](https://cloud.yunmomo.com/js/6821.625acfeb.js) | Transfer API 95938、OneToOneTransferDialog 76821；sendPairs / status / 清状态及 50 对限制 | 63C3CB5D5B100006E62D9BA2D7FB4D7835850AB3A434F0014DB526542CB1D325 |
| [4381.fd010c48.js](https://cloud.yunmomo.com/js/4381.fd010c48.js) | ScVpcList 18116；查询、删除、导入导出与分组筛选 | 847F7362786DBAA5FB6456A661AACDEB7ED4503724EB91314DCF34515B5ABD81 |
| [457.6182f1c8.js](https://cloud.yunmomo.com/js/457.6182f1c8.js) | ScVpcForm 80457、API 92681；save 字段、端口校验、路径/方法 | B17AAE63CAE5877CBEFE880D81019FECF5941798084C1673E91B2E0366AEA41A |
| [4046.665c4294.js](https://cloud.yunmomo.com/js/4046.665c4294.js) | ScVpcGroupForm 64046、group API 54914；keep/delete 两种模式 | 49E708E13E704EB5104036F2E9C13ED796693DF0F5EAB2773DDA8EF7C0FE835A |
| [1186.03d8e810.js](https://cloud.yunmomo.com/js/1186.03d8e810.js) | ScVpcPatchForm 11186、Preview 93742；批量解析后提交数组 | 8EC72ED9208A27803C7CF81E179EF849CA49D3DA2ECF9157DD3E14B906A1F511 |

通用上传器位于官方 index.4bc49eda.js：doUpload 创建 FormData，filename 默认 file，没有云盘侧额外必填 data；普通传输列表 1502.50635c7d.js 调用 send/status，不传 taskId。公开脚本原件仅留在忽略的 `.research/` 内，npm 包不包含这些研究文件。

本地验证：`npm test` 57/57 通过，其中新增管理测试 17 个；声明与调用方 TypeScript 严格编译通过。协议测试覆盖 GET/POST/DELETE、查询编码、multipart、JSON 对象/数组、空任务、相对路径、参数边界、出错不下发和敏感信息不进入对象 JSON。只读复测示例：设置当前账号 YUNMOMO_TOKEN 后执行 `npm run check:management`。

界面证据只截工具栏，不包含 VPC 密码列或文件列表：

![云盘工具栏](D:/AA-project/自动化/.local-output/management-cloud-toolbar.jpg)

![VPC 查询与分组工具栏](D:/AA-project/自动化/.local-output/management-vpc-toolbar.jpg)
