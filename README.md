# Team Calendar（GitHub Pages + Supabase 免费版）

一个带登录的团队日历网站：月 / 周 / 日视图（周日→周六，每 30 分钟一格），管理员发布日程，成员回复（确定参与 / 会迟到+分钟 / 不确定 / 无法参与），留言板，任务栏，以及完整的操作记录。

- 网页托管：GitHub Pages（免费，公开仓库）
- 数据库 / 登录 / 实时：Supabase Free
- 数据保留：**过去 3 个月 + 未来 12 个月**。日程只能建在这个范围内；每天自动删除 3 个月前的日程、留言、任务和操作记录。

## 角色
| 角色 | 可以做什么 |
|---|---|
| 创建者 owner | 全部权限；设/撤管理员；删除账号 |
| 管理员 admin | 发布/编辑/删除日程和任务；创建账号；重置普通成员密码；删除任意留言；查看操作记录 |
| 成员 member | 查看全部内容；回复日程；发留言（可删自己的）；改自己的显示名称和密码 |

---

## 部署步骤（约 20 分钟）

### 1. 创建 Supabase 项目
1. 在 <https://supabase.com> 注册并 **New project**（Free 计划，Region 选 US East 或 US Central）。
2. 记下数据库密码（备份时会用到）。

### 2. 建数据库
1. 左侧 **SQL Editor → New query**，把 `supabase/schema.sql` 全部粘贴进去，点 **Run**。
2. 如果提示 `pg_cron` 相关错误：左侧 **Integrations → Cron** 先启用，再重新运行一次（脚本可重复运行）。

### 3. 关闭公开注册
**Authentication → Sign In / Providers**，关闭 **Allow new users to sign up**。
（账号只能由你或管理员在网站里创建。）

### 4. 创建你自己的创建者账号
1. **Authentication → Users → Add user → Create new user**
   - Email：`你的用户名@team.local`（例如 `baiheng@team.local`）
   - Password：你的密码
   - 勾选 **Auto Confirm User**
2. 回到 **SQL Editor** 运行（把用户名换成你的）：
   ```sql
   update public.profiles set role = 'owner' where username = 'baiheng';
   ```

### 5. 部署账号管理函数
1. **Edge Functions → Deploy a new function → Via Editor**
2. 函数名必须是 `admin-users`，把 `supabase/functions/admin-users/index.ts` 全部粘贴进去，**Deploy**。
3. 打开这个函数的 **Settings**，把 **Verify JWT with legacy secret** 关掉并保存（函数代码里自己校验登录身份和管理员权限）。

### 6. 填写网站配置
**Project Settings → API Keys**（或顶部 **Connect**）里复制：
- Project URL → 填到 `config.js` 的 `SUPABASE_URL`
- Publishable key（或旧版 anon key）→ 填到 `SUPABASE_KEY`

这个 key 放在公开网页里是安全的；没登录的人什么都读不到，登录后的权限由数据库规则（RLS）控制。**不要**把 service_role / secret key 放进网页。

### 7. 发布到 GitHub Pages
1. 在 GitHub 新建一个 **Public** 仓库（免费账号的 Pages 需要公开仓库；代码公开没关系，数据在 Supabase 里受登录保护）。
2. 把整个文件夹推上去（包括隐藏的 `.github` 文件夹）：
   ```bash
   cd team-calendar
   git init && git add -A && git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/<你的GitHub名>/<仓库名>.git
   git push -u origin main
   ```
3. 仓库 **Settings → Pages**：Source 选 **Deploy from a branch**，Branch 选 `main` / `/ (root)`，保存。
4. 一两分钟后网址是 `https://<你的GitHub名>.github.io/<仓库名>/`。

### 8. 开启保活 + 备份（强烈建议）
Supabase 免费项目 **7 天没有访问会被暂停**，长期暂停可能被删除；免费版也没有自动备份。`.github/workflows/maintenance.yml` 会：
- 每天访问一次数据库（防暂停）
- 每周日做一次**加密**备份，保存为 Actions 的 artifact（保留 90 天）
- 每月 1 号做一个很小的提交，防止 GitHub 因仓库 60 天无活动而停用定时任务

设置方法：仓库 **Settings → Secrets and variables → Actions → New repository secret**
- `SUPABASE_DB_URL`：Supabase 顶部 **Connect → Session pooler** 的连接串（把 `[YOUR-PASSWORD]` 换成数据库密码）
- `BACKUP_PASSPHRASE`：自己设一个长密码，用来加密备份（**一定要记住**，丢了就解不开备份）

然后到 **Actions → Maintenance → Run workflow** 手动跑一次，确认是绿色的 ✓。
（不设这两个 secret 也可以，只是不备份；每日保活照常运行。）

解密备份：
```bash
gpg -d backup-2026-11-22.tgz.gpg > backup.tgz && tar xzf backup.tgz
```

---

## 日常使用
- **加人**：登录 → 成员 → 创建账号（用户名 + 初始密码），把这两样发给对方。对方登录后在「我」里改显示名称和密码。
- **发布日程**：日历切到周/日视图，点一下某个 30 分钟格（手机上点一下默认 1 小时；电脑上可以拖动选多格），填写名称、地点、着装、备注。
- **回复**：点开日程选择回复；选「会迟到」需要填分钟数。展开名单可以看到按 出席 → 迟到 → 不确定 → 无法参与 → 未回复 排列的所有人。
- **操作记录**：管理员在「记录」里查看谁在什么时候登录、新增 / 修改 / 删除了什么。

## 免费额度
Supabase Free：500 MB 数据库、5 GB 流量/月、5 万月活用户、2 个项目。这个网站只存文字，加上 15 个月的保留期，一个小团队用不到额度的零头。

## 文件说明
```
index.html / styles.css / app.js   网页
config.js                          Supabase 地址和 key（需要你填写）
supabase/schema.sql                数据库表、权限规则、操作记录、保留期清理
supabase/functions/admin-users/    创建账号 / 重置密码 / 设管理员 / 删除账号
.github/workflows/maintenance.yml  保活、备份
```
