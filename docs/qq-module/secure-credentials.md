# QQ 模块专用安全凭据

此组件仅供经审查的 MAIN-process 主机组合使用，不注册 renderer 秘密 IPC，不导入旧明文或混淆 token，也不自行获取或更改真实 QQ/NapCat 凭据。固定目录由 qqSecureCredentialDirectory(userDataPath) 返回，不能使用 renderer、模块包或网络提供的路径。

## 系统加密适配器

createQqElectronSecureStoragePort 默认使用真实 Electron app/safeStorage 接口。每次调用都重新检查 app.isReady() 和 safeStorage.isEncryptionAvailable()，不缓存启动早期的 false。Linux 只接受明确的 gnome_libsecret、kwallet、kwallet5、kwallet6 后端；basic_text、未知后端与不支持的平台拒绝，不提供任何明文或混淆回退。

测试可以注入适配器依赖。通过模拟测试不表示已验证 Windows 原生安全存储，也不应把测试端口用于生产配置。

## API 与身份绑定

- getMetadata()：返回 accountId、随机 UUID generation、active/revoked，或者无存储时null。只读元数据，绝不解密。revoked不能当作active或缺失。
- write({accountId,token,expectedGeneration,userConfirmed:true})：明确授权的主机保存操作。首次expectedGeneration为null；替换必须匹配当前代次。新值使用新UUID，避免旧预览取得新token。
- read({accountId,generation})：必须是active并精确匹配账号/代次，当前系统安全存储可用才解密。
- revoke({accountId,generation,userConfirmed:true})：原子写入revoked tombstone，不解密；系统keychain暂不可用也能撤销未来读取。
- restore({accountId,generation,userConfirmed:true})：只恢复匹配的revoked记录，显式解密后用新UUID重新加密，不复活旧预览。

密文内部包含schemaVersion、accountId、generation和token；解密时再次匹配外部元数据，不能通过仅重标外部账号/代次把旧token用于不同身份。generation来自随机数，不是token内容、摘要或密码派生值。

## 持久化与中断

专用目录和文件采用owner-only权限。严格限制路径、链接/硬链接、schema、字段、token长度、ciphertext大小和canonical base64。写入使用独占锁、同目录临时文件、文件fsync和原子rename；POSIX同时fsync目录。Windows真实文件系统与安装器验收仍不可省略。

替换在rename前失败，旧密文保留；rename后故障报告commit-uncertain，调用者应重新查询元数据，不能宣称没有保存。陈旧锁、损坏记录、缺少状态或不认识的目录失败关闭，不自动删锁、重置或重新创建。测试故障注入仅用于主机测试。

撤销保留密文以支持明确恢复，**不是磁盘擦除**。同OS用户的恶意代码可能读取、回放或改写本地文件；本组件不是该攻击者的安全隔离边界。

## 撤销的运行时边界

低层store.revoke只禁止之后从此存储读取，不会停止已经解密并持有token的运行时，也不等于在NapCat后端撤销token。它不可被renderer裸调用。真实UI撤销必须先经受控disable和停机证明，再调用revoke；需要更改后端token时由用户或有授权的维护者完成独立操作。

生产激活组合只应持有读取接口。保存、替换、撤销、恢复均属于明确的主机管理动作，不因为添加此组件就自动开放。

## 验证

测试使用临时目录和合成token；存储测试用内存随机密钥AES-GCM模拟系统加密端口，适配器测试验证真实Electron接口调用契约及动态可用性判断。覆盖代次轮换、账号绑定、元数据不解密、revoked恢复新代次、写盘前后故障、恶意/过大schema、陈旧锁、硬链接、断链符号链接和ready前后变化。没有使用真实凭据。
