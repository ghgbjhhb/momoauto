'use strict';

// Read-only. Do not print file URLs or VPC credentials to logs.
const { YunmomoClient } = require('../src');

async function main() {
  const client = new YunmomoClient();
  const disk = client.cloudDisk();
  const vpc = client.vpc();
  const [privateFiles, publicFiles, usage, publicUsage, lines, groups, transfers, pairs] = await Promise.all([
    disk.list(), disk.list({ channel: '2' }), disk.usage(), disk.usage('2'),
    vpc.list(), vpc.groups().list(), disk.transferStatus(), disk.pairStatus()
  ]);
  console.log({ privateFiles: privateFiles.total, publicFiles: publicFiles.total,
    usedBytes: usage.fileSizeTotal, publicUsedBytes: publicUsage.filePublicSizeTotal,
    vpcLines: lines.total, vpcGroups: groups.total,
    transfers: { total: transfers?.totalCount, finished: transfers?.finished, expired: transfers?.expired },
    pairs: { total: pairs?.totalCount, finished: pairs?.finished, expired: pairs?.expired } });
}

main = require('../src/automation/timing').timedScript('script.examples.management', main);

main().catch(error => { console.error(error.message); process.exitCode = 1; });
