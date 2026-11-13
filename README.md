# 周大神发票合并助手 · invoice-two-up

把两张电子发票合成到**一张 A4 纸**上打印。纯浏览器处理，部署在 Cloudflare Pages。

- 输入：两张发票，格式为 PDF 或 JPG/PNG，也可以是两个可直接访问的直链
- 处理：自动裁掉四周白边 → 按票面原比例缩放到 210×297 mm → 300 DPI 合成
- 输出：一页 A4（2480×3508 px），可直接打印，也可导出 PDF 或 PNG

线上直接用：**<https://invoice-two-up.pages.dev>**

## 使用方法

1. 打开上面的地址，整页就是一个工作台，无需登录。
2. **发票 A**：把 PDF / JPG / PNG 拖进左侧框，或点击选择；也可以粘贴发票直链后点「读取」。
3. **发票 B**：同上。一次选中两个文件会分别落到 A 和 B；顺序反了就点「交换 A / B」。
4. 调两个参数：页边距（默认 6 mm）、两票间距（默认 4 mm）；需要裁切线就选「虚线」，方便打出来对折。
5. 看右侧预览，确认两张票都在红色虚线版心内。状态栏会给出「占版心 x%，最低清晰度约 y DPI」，低于 180 建议换原始文件。
6. 点 **打印一页 A4**，在打印对话框里按下面的「打印设置」调一次，之后不用再改。
7. 不想打印就点 **下载 PDF** 或 **保存 PNG**，文件直接存到本地，不上传任何服务器。
8. 用完刷新页面，内存里的发票就没了；页面不带统计、不留日志。

打印设置只需设一次：纸张 **A4**、缩放 **实际大小 100%**、边距 **无**、取消 **页眉页脚**。选了「适应页面」，浏览器会把已经排好的整页再缩一次，票面会变小。

## 为什么需要它

电子发票平台导出的 PDF 通常是一整页 A4，票面只占上半部分。两张原样打出来就是两页，第二张还要被打印机「适应页面」再缩一次，字迹和二维码都会糊。这个工具做的是**版式合并**：把票面内容取出来，重新排到一页上。

它不会替你核验发票真伪，也不改票面任何内容。

## 功能

| 能力 | 说明 |
| --- | --- |
| 双票合并 | 两张票上下排列，整体居中，间距可调 |
| 自动裁白 | 以四边中位色判定纸张底色，框出票面内容，外留 0.7% 画幅的安全区 |
| 三种排列 | 紧凑（按内容重排）、上下对半（各占半页）、单张占半页 |
| 尺寸锁定 | 画布固定 2480×3508，A4 满幅，300 DPI |
| 清晰度提示 | 每张票算出「印出来相当于多少 DPI」，低于 180 直接提示 |
| 边缘提醒 | 票面内容贴到原图边缘时告警，避免闷头裁掉印章 |
| 多页 PDF | 可切换页码；一次选两个文件会自动分配到 A / B |
| 纸面增白 | 扫描件、手机照片的灰底推到白色，原始电子发票几乎无变化 |
| 裁切线 | 无 / 虚线 / 实线，方便打出来对折或裁开 |
| 旋转 | 横向票面可 90° 旋转 |
| 输出 | 浏览器打印、单页 A4 PDF（JPEG 直嵌）、2480×3508 PNG |
| 网址直链 | 经边缘函数代理取回，绕开跨域限制 |

## 本地跑

```bash
npm install
npm run dev
# 打开 http://localhost:8788
```

`npm run dev` 等价于 `wrangler pages dev public`，会同时启动静态页面和 `functions/` 里的代理函数。

只想看页面、不需要网址直链，也可以直接把 `public/` 丢给任意静态服务器：

```bash
npx serve public
```

## 部署到 Cloudflare Pages

这个项目是纯静态页面 + 一个边缘函数（`functions/api/proxy.js`），没有构建步骤，Pages 免费计划就够用。

### 准备

- Cloudflare 账号（免费计划即可，Pages 不计流量费）
- Node.js 18 或更高（用命令行部署时需要）
- 仓库已 clone 到本地，或已 fork 到自己的 GitHub
- 自定义域名可选，没有也能用 `*.pages.dev`

部署前确认三件事，后面几乎所有失败都出在这里：

| 必须满足 | 说明 |
| --- | --- |
| 部署目录是 `public/` | 页面、样式、pdf.js 全在这里 |
| 命令在**仓库根目录**执行 | `functions/` 在根目录，Pages 只从根目录读取函数 |
| 不要填构建命令 | 没有 npm build，填了反而会失败 |

### 方式一：连 GitHub 自动部署（推荐）

一次配置，以后 `git push` 就自动发布新版本。

1. 把仓库推到 GitHub（本仓库已经是 <https://github.com/zhoudahsen/invoice-two-up>）。
2. 打开 Cloudflare Dashboard → **Workers & Pages** → **Create** → 选 **Pages** → **Connect to Git**。
3. 授权 GitHub，选中 `invoice-two-up` 仓库，点 **Begin setup**。
4. 构建设置按下表填，其余留空：

   | 字段 | 填写 |
   | --- | --- |
   | Project name | `invoice-two-up`（决定 `xxx.pages.dev` 前缀） |
   | Production branch | `main` |
   | Framework preset | `None` |
   | Build command | **留空** |
   | Build output directory | `public` |
   | Root directory | 留空（即仓库根目录） |

5. 点 **Save and Deploy**，等 30 秒左右完成首次构建，拿到 `https://invoice-two-up.pages.dev`。
6. 之后每次 push 到 `main` 都会自动重新部署；推其它分支会生成独立的预览域名，不影响生产。

### 方式二：命令行直传（Wrangler）

不想连 GitHub、或者想手动控制发布时机时用这个。

1. 安装依赖并登录：

   ```bash
   npm install
   npx wrangler login          # 浏览器授权
   ```

   无浏览器的服务器改用 API Token：

   ```bash
   export CLOUDFLARE_API_TOKEN="你的 Token"
   export CLOUDFLARE_ACCOUNT_ID="你的账户 ID"
   ```

   Token 需要在 Dashboard 里创建，权限至少包含 **Account → Cloudflare Pages: Edit**。

2. 首次部署先建项目（已建过可跳过）：

   ```bash
   npx wrangler pages project create invoice-two-up --production-branch main
   ```

3. 在**仓库根目录**发布：

   ```bash
   npx wrangler pages deploy public --project-name invoice-two-up --branch main
   ```

   成功后会打印一个本次部署的预览域名，生产域名固定是 `https://invoice-two-up.pages.dev`。

4. 更新内容：改完文件重复执行第 3 步即可；也可以直接用 `npm run deploy:pages`。

### 方式三：控制台上传 zip（不推荐）

Deployments → **Create new deployment** 可以拖 zip 上传，但有硬伤：

- 只能传静态资源，**`functions/` 不会跟着上传**，部署上去 `/api/proxy` 就没了，网址直链功能失效；
- zip 的**根目录**必须是 `index.html` 所在的那一层，套一层 `public/` 文件夹会 404。

只适合临时换页面看效果，不要用它发正式版。

### 绑定自定义域名

1. Pages 项目 → **Custom domains** → **Set up a domain**。
2. 输入域名，例如 `invoice.example.com`。
3. 域名在同一个 Cloudflare 账号下：会自动添加 CNAME 记录，等状态变成 **Active** 即可。
4. 域名在别处：按提示到 DNS 服务商添加 CNAME，指向 `invoice-two-up.pages.dev`。
5. 证书由 Cloudflare 自动签发，生效后 `https://invoice.example.com` 直接可用。

### 设置环境变量（可选）

代理默认允许任意公网 PDF/图片地址。想收紧成白名单：

1. 项目 → **Settings** → **Environment variables** → **Production** → **Add variable**。
2. 名称 `ALLOWED_HOSTS`，值 `invoice.example.com,cdn.example.com`（英文逗号分隔）。
3. 保存后**重新部署一次**才生效。

### 部署后自检

把下面的地址换成你的域名，四条都过才算部署正确：

```bash
# 1. 首页
curl -I https://invoice-two-up.pages.dev

# 2. pdf.js 静态资源（应当 200，约 320 KB）
curl -I https://invoice-two-up.pages.dev/vendor/pdf.min.js

# 3. 代理函数（应当 200 + application/pdf）
curl -I "https://invoice-two-up.pages.dev/api/proxy?url=https%3A%2F%2Fpdfobject.com%2Fpdf%2Fsample.pdf"

# 4. 内网地址必须被拒（应当 403）
curl -I "https://invoice-two-up.pages.dev/api/proxy?url=http%3A%2F%2F127.0.0.1%2F"
```

然后在浏览器里放两张发票、点打印，能出单页 A4 就说明端到端都通了。

### 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `/api/proxy` 返回 404 | `functions/` 没被识别 | 确认部署时在仓库根目录、`functions/api/proxy.js` 路径没改 |
| 构建失败，提示找不到命令 | Build command 填了东西 | 清空构建命令，本项目不需要构建 |
| 首页 404 或空白 | 输出目录填错 | 必须是 `public`，不是 `public/` 的上级或子级 |
| 拖 zip 后直链功能失效 | zip 里没有函数 | 改用命令行或 Git 集成部署 |
| 打开还是旧页面 | 部署未完成或缓存 | Deployments 里看最新一条状态，或强刷浏览器 |
| 自定义域名 522 / 打不开 | DNS 没走 Cloudflare 代理 | CNAME 记录开启橙云代理，等证书签发 |
| 代理返回 403 | 目标站点拒绝 Cloudflare 出口 | 换一个能直接下载的发票直链，或先把文件下载后本地上传 |

### 更新与回滚

- 更新：Git 集成下 push 即可；命令行方式重跑 `pages deploy`。
- 回滚：Deployments 找到上一个正常版本 → 右侧 `…` → **Rollback to this deployment**。
- 删除：项目 Settings 底部 **Delete project**，删掉后 `xxx.pages.dev` 立即失效。

## 目录结构

```
invoice-two-up/
├── public/
│   ├── index.html          工作台（单页）
│   ├── assets/
│   │   ├── style.css       票据纸张风格的样式
│   │   └── app.js          读入 / 裁白 / 合成 / 打印 / 导出的全部逻辑
│   ├── vendor/
│   │   ├── pdf.min.js      pdf.js 3.11（PDF → 位图）
│   │   └── pdf.worker.min.js
│   ├── _headers            安全响应头
│   └── robots.txt
├── functions/api/proxy.js  发票直链代理（Pages Function）
├── wrangler.toml           Pages 配置（Pages 只认这个文件名）
└── package.json
```

## 已验证

- 两张 2480×3508 的票面合成后：单页 2480×3508，最低清晰度 321 DPI，四边留白 6–11 mm
- 导出 PDF 被 `pdfinfo` 识别为 `Pages: 1`、`595.28 x 841.89 pts (A4)`
- 浏览器打印（`page.pdf`，A4、边距 0）输出单页，两票上下排列、中间有裁切线
- 代理 14 项边界单测全部通过（缺参、内网、十进制 IP、白名单、HTML 拒绝、超大、重定向到内网等）
- 390×844 窄屏下 `scrollWidth === 390`，无横向溢出

## 合成规则

| 项 | 取值 |
| --- | --- |
| 页面 | A4 纵向，210 × 297 mm |
| 分辨率 | 300 DPI，画布 2480 × 3508 px |
| 页边距 | 0–20 mm，默认 6 mm |
| 两票间距 | 0–14 mm，默认 4 mm |
| 内容安全区 | 裁切外框外扩 0.7% 画幅（2480 px 画布上约 17 px） |
| 缩放策略 | 先按可用宽度等比缩放；总高超一页时两张按同一系数再缩 |
| 上下对半 | 每张限制在半个版心内等比缩放，两张各自居中 |

紧凑模式优先把票面放大；对半模式优先保证上下两联固定对齐。

## 打印设置

打出来偏小、票面比预期小一圈，基本都是这一步没设对：

1. 纸张选 **A4**
2. 缩放选 **实际大小 100%** 或「无」，**不要**选「适应页面」
3. 页边距选 **无**
4. 取消勾选 **页眉和页脚**

## 发票直链接口

```
GET /api/proxy?url=<URL 编码后的直链>
```

返回原始字节，`content-type` 由文件头判定，不走缓存。

安全边界：

- 只接受 `http` / `https`
- 只放行 `application/pdf` 与图片（按文件头 magic bytes 判断，不看响应头）
- 单文件上限 20 MB，超时 15 秒
- 拒绝 localhost、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`、CGNAT、IPv6 字面量、十进制 IP
- 重定向后再校验一次目标域名
- 可选 `ALLOWED_HOSTS`（逗号分隔）做域名白名单

```toml
[vars]
ALLOWED_HOSTS = "invoice.example.com,cdn.example.com"
```

它是给发票文件用的窄口代理，不是通用 CORS 代理；公开部署时建议配上白名单或加限流。

## 二次开发

**改成三张一页**：`public/assets/app.js` 里的 `compose()` 目前遍历 `['a', 'b']`。把它换成数组、按行数重算 `slotH`，并同步改 `PAGE_W` 相关缩放系数即可；裁切、增白、导出都可以复用。

**换字体 / 换配色**：`style.css` 顶部的 `:root` 变量，`--seal` 是印章朱红，`--paper` 是纸白。

**改裁白阈值**：`detectBox()` 里的 `thr = 20`，值越小裁得越紧。

## 已知限制

- 不解析票面字段，不做 OCR，不判断发票真伪与重复报销
- 加密或需要打开密码的 PDF 无法读取
- 一页固定两张；三张及以上需要改代码
- 扫描件清晰度受原图限制，工具只能提示、不能凭空提升
- 网址必须是直接返回文件的地址，开票平台的登录预览页取不到

## 许可

MIT，见 `LICENSE`。内置 pdf.js 为 Apache-2.0，见 `THIRD-PARTY.md`。
