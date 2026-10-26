# 云 momo 云手机自动化

本地网页控制台、10 个业务脚本、可复用的 Node.js SDK，以及中文分词和拼音输入模块。原有 SDK 导入方式和脚本名称保持不变。

控制台启动：`npm run app`。业务入口见 [脚本清单](flows/README.md)，开发归属见 [项目目录](docs/PROJECT-STRUCTURE.md)，完整说明见 [文档索引](docs/README.md)。模型及训练、标注和评测资料保持原位，不随应用目录整理搬迁。

0.3.0 增加云盘与 VPC 管理：私有/公共文件、用量、上传/重命名/删除、传输与一机一传、任务状态；VPC 线路与分组增删改查、批量保存、连接测试、Excel 导入导出。

## 开始使用

所有 01～14 业务脚本及 SDK 工具默认记录耗时，日志位于 `.runtime/timings/`；运行 `npm run timing:report` 查看慢步骤。详见 [脚本计时](docs/SCRIPT-TIMING.md)。

Node.js 18+，本机已安装的版本为 24。令牌来自你自己的登录会话，不会自动提取浏览器凭据，也不会写进源码。

~~~powershell
npm ci
$env:YUNMOMO_TOKEN = '<当前登录令牌>'
npm run example
~~~

先从设备列表取得目标的 deviceId、udid；不要按名字 SF 自动选取，因为账号可能有多台同名设备。

~~~powershell
$env:YUNMOMO_DEVICE_ID = '<目标 deviceId>'
$env:YUNMOMO_UDID = '<目标 udid>'
npm run check:live
~~~

check:live 检查设备列表、截图及视频通道初始元数据，不点击手机、不重置设备、不上传文件；建立通道时会发送视频参数。普通 npm test 不需要登录，也不访问真实云机。

如果使用 .env：复制 .env.example 后填入自己的配置；Node.js 20.6+ 可运行 node --env-file=.env examples/basic.js。SDK 本身只读取环境变量，不自动加载 .env。令牌失效后更新环境变量，并新建 client/control。

## 调用示例

~~~js
const { YunmomoClient } = require('D:/AA-project/自动化');

async function main() {
  const client = new YunmomoClient();
  const phone = client.device(process.env.YUNMOMO_DEVICE_ID);
  const control = await phone.openControl({
    udid: process.env.YUNMOMO_UDID || undefined
  });

  try {
    await control.connect();                 // 等待初始元数据，并同步视频坐标尺寸
    control.home();
    await control.tap(100, 200);
    await control.swipe(
      { x: 200, y: 600 }, { x: 200, y: 200 },
      { durationMs: 500, steps: 12 }
    );
    control.overview();                      // 最近任务
    control.volumeUp();
    control.volumeDown();
    const clipboard = await control.getClipboard();
    console.log(clipboard);
    const image = await phone.screenshot();  // image.data 是图片 Buffer，可交给 OCR
  } finally {
    await control.close();
  }
}
main().catch(error => console.error(error.message));
~~~

坐标对应当前视频帧，不是网页截图的像素坐标；以 control.screenWidth / screenHeight 为准。完整例子见 examples/control.js，运行它需要显式传入 --demo。

## 功能入口

- [本地脚本控制台](docs/APP.md)
- [文档索引与项目目录](docs/README.md)
- [截图按钮与接口对应表](docs/TOOLBAR.md)
- [接口、参数、事件与返回值](docs/API.md)
- [底层截图、点击与连续滑动工具](docs/DEVICE-TOOLS.md)
- [GPU 常驻识别：四类识别、OCR、跨进程共享与预热](docs/GPU-RECOGNITION.md)
- [工具代码提速范围与实测](docs/PERFORMANCE.md)
- [打开 MOMO：桌面查找、翻页与 YOLO 启动确认](docs/OPEN-MOMO.md)
- [发送联系方式：模型 2、键盘状态与 3+3+剩余分段](docs/SEND-CONTACT.md)
- [拉黑对方：模型 2 顶栏头像与确认弹窗](docs/BLOCK-PEER.md)
- [MOMO 首页刷新与循环浏览：模型 1 定位、区域点击与有限轮次](docs/MOMO-HOME.md)
- [云盘、VPC 网络与分组管理接口](docs/MANAGEMENT.md)
- [中文分词、拼音与云手机键盘输入](docs/CHINESE-TYPING.md)
- [协议证据与验证边界](docs/PROTOCOL.md)
- [更新记录](CHANGELOG.md)

npm run capabilities 可在不登录的情况下列出所有入口。

~~~js
const disk = client.cloudDisk();
const privateFiles = await disk.list();
const publicFiles = await disk.list({ channel: '2' });
const usage = await disk.usage();
const lines = await client.vpc().list();
const groups = await client.vpc().groups().list();
~~~

设置 `YUNMOMO_TOKEN` 后，`npm run check:management` 只读检查云盘和 VPC，不上传、删除、发送文件或更改代理。不要直接打印 VPC records，它们含线路用户名和密码；文件 url 也可能包含有时效的下载凭据。

## 验证状态

云盘/VPC：2026-10-12 已通过当前登录账号的真实列表、详情、用量、文件链接解析、两类任务状态查询；私有文件 8 个、公共文件 25 个、VPC 5 条、分组为空。上传/删除/修改、批量传输、代理连接测试、导入导出及分组写操作仅做本地协议测试，未改动真实数据。详见 [管理接口实测报告](docs/MANAGEMENT-LIVE-TEST-2026-10-12.md)。

2026-10-12 已在用户指定的第三台 SF 上完成核心操作实测：设备列表/详情/截图、连接、点击/长按/滑动/滚轮、导航/音量、通知栏、英文输入/中文粘贴、剪贴板读写、视频尺寸、手动刷新和真实断线自动重连；网页尺寸、三个偏好开关、当前可见侧栏入口也进行了实测。发现并修复了滑块数值/焦点、关闭开关的状态读取、菜单动画和提示框遮挡问题。详见 [实机测试报告](docs/LIVE-TEST-2026-10-12.md)。

没有完成全部真实云机联调：旋转/屏幕电源命令没有可确认的画面变化；实际上传/安装、参数修改、代理设置、音频播放及证书安装仍未验证。代理查询、文件列表及带 id 的国家代码查询已返回正常结果，不能据此推断其写操作已经通过。

没有在测试中执行重置、换镜像、证书安装、分享或转移。后台复杂动作保留原始参数透传；网页的账户级子菜单提供打开入口，不自动提交确认对话框。页面升级或账号权限差异可能影响可用功能。

截图可以接 OCR/视觉模型，video 事件可接 H.264 解码器；SDK 不包含 OCR、视频解码或“不可被识别为自动操作”的保证。
