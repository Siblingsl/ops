// R3-C：硬禁区词表覆盖审计（Windows 常见敏感工具对照 policy.js 表）
// 表内已有：winlogon/csrss/wininit/lsass/smss/taskmgr/cmd/powershell/pwsh/regedit/secpol/gpedit/credential/vault/uac/consent/中文六词
const IN_TABLE = ['winlogon','csrss','wininit','lsass','smss','taskmgr','cmd.exe','powershell_ise','pwsh','regedit','secpol.msc','gpedit.msc','credential manager','凭据管理','密码管理','命令提示符','注册表','安全中心'];
// 候选遗漏（Windows 常见敏感/可执行逃逸面）
const CANDIDATES = [
 ['wmic', 'wmic.exe（已弃用但仍可执行系统查询）'],
 ['diskmgmt', 'diskmgmt.msc（磁盘管理）'],
 ['services', 'services.msc（服务管理）'],
 ['devmgmt', 'devmgmt.msc（设备管理）'],
 ['task scheduler', 'taskschd.msc（任务计划程序）'],
 ['lusrmgr', 'lusrmgr.msc（本地用户和组）'],
 ['eventvwr', 'eventvwr.msc（事件查看器）'],
 ['ncpa.cpl', 'ncpa.cpl（网络连接）'],
 ['control', 'control.exe（控制面板）'],
 ['cmd /c', "字符串 cmd /c 注入形态"],
 ['start-process', 'PowerShell 别名 start-process'],
 ['invoke-expression', 'PowerShell iex/Invoke-Expression'],
 ['certutil', 'certutil（证书下载滥用面）'],
 ['bitsadmin', 'bitsadmin（下载滥用面）'],
 ['mshta', 'mshta（HTA 执行滥用面）'],
 ['rundll32', 'rundll32'],
 ['reg add', 'reg add（注册表写）'],
 ['net user', 'net user（账户操作）'],
 ['terminal', 'Windows Terminal（wt.exe/terminal）'],
 ['wt.exe', 'wt.exe'],
];
let missing=[];
for(const [k,why] of CANDIDATES){
  const hit=IN_TABLE.some(p=>k.toLowerCase().includes(p.toLowerCase()));
  if(!hit)missing.push(k+' —— '+why);
}
console.log('表内词数:',IN_TABLE.length);
console.log('候选遗漏:');
missing.forEach(m=>console.log(' -',m));
